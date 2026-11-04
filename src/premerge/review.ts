// Pre-merge review: Opus reads, independently of the first review, the head commit of each PR the merge rule would merge
// without a person, and lists defects and minor findings. One call per PR head. Reads GitHub (the diff); writes only to
// the local database. What the findings do to the PR is the merge queue (src/merge/queue.ts) and the fix-up route.
import type { DatabaseSync } from "node:sqlite";
import { claudeRoom } from "../agents/call.ts";
import { add, askClaude, pool, saveUsage, type Usage } from "../classify/run.ts";
import { buildQueue, type QueueEntry } from "../merge/queue.ts";
import { CLAUDE_PROMPTS } from "../prompts/index.ts";
import { referenceDir } from "../reference.ts";
import { defaultSemanticDeps, referenceProblems, type SemanticDeps } from "../reference-lint.ts";
import { dropTexts, type Lint } from "../replylint.ts";
import { sizeOf } from "../review/candidates.ts";
import { defaultOpusDeps, prepareOpusInput, type OpusDeps } from "../review/opus.ts";
import type { OpusCandidate } from "../review/opus-candidates.ts";
import { REPO_PATH } from "../sandbox/command.ts";
import { checkoutForPr } from "../sandbox/index.ts";
import { lintPremerge, parsePremerge, premergeTexts, type PremergeReview } from "./parse.ts";
import { RETRY_AFTER_MS } from "../postmerge/select.ts";
import { PREMERGE_MAX_TRIES, premergeAt, premergeRetryDue, savePremerge } from "./store.ts";

const PROMPT = CLAUDE_PROMPTS["premerge.opus"];
const now = () => new Date().toISOString();
const refOf = (c: { repo: string; number: number }) => `${c.repo}#${c.number}`;

export type PremergeParams = {
  repo: string; limit?: number;
  /** Only this PR (the `--number` option). */
  number?: number;
  dryRun?: boolean;
  onHandled?: (n: number) => void;
};
export type PremergeDeps = Pick<OpusDeps, "fetchDiff" | "model" | "maxChars" | "checkout" | "semantic"> & { now?: () => number };
export type PremergeSummary = { runId: string; repo: string; candidates: string[]; reviewed: number; findings: number; defects: number; failed: string[]; moved: string[] };

export function defaultPremergeDeps(): PremergeDeps {
  const d = defaultOpusDeps();
  return { fetchDiff: d.fetchDiff, model: PROMPT.models[0]!, maxChars: d.maxChars, checkout: (r, n, h) => checkoutForPr(r, n, h, console.log) };
}

/**
 * The PRs of `repo` the queue holds in waiting-premerge whose head is due a try, in queue order. `wake` collects when the
 * failed tries are due again (ms): nothing in the data changes then, so the planner must be told.
 */
export function premergeCandidates(db: DatabaseSync, repo: string, at = Date.now(), wake?: number[]): QueueEntry[] {
  return buildQueue(db, { repo, merged: "exclude" }).filter((e) => {
    if (e.state !== "waiting-premerge") return false;
    const row = premergeAt(db, repo, e.number, e.head);
    if (row && row.findings === null && row.tries < PREMERGE_MAX_TRIES) wake?.push(Date.parse(row.at) + RETRY_AFTER_MS);
    return premergeRetryDue(row, at);
  });
}

/** The Opus candidate of a queue entry: the PR's title, body, size and author association from its items row. */
export function candidateOf(db: DatabaseSync, e: QueueEntry): OpusCandidate {
  const it = db.prepare("SELECT title, body, author_association, additions, deletions FROM items WHERE repo = ? AND number = ?").get(e.repo, e.number) as
    { title: string | null; body: string | null; author_association: string | null; additions: number | null; deletions: number | null } | undefined;
  const lines = (it?.additions ?? 0) + (it?.deletions ?? 0);
  return { repo: e.repo, number: e.number, title: it?.title ?? e.title, body: it?.body ?? "", author_association: it?.author_association ?? null, head_oid: e.head, lines_changed: lines, size: sizeOf(lines), score: null };
}

/** True while the queue still lists the PR at this head, open and not yet reviewed. */
const stillHead = (db: DatabaseSync, repo: string, number: number, head: string): boolean =>
  buildQueue(db, { repo, refs: [`${repo}#${number}`], merged: "exclude" }).some((e) => e.head === head);

export async function runPremerge(db: DatabaseSync, params: PremergeParams, log: (line: string) => void = console.log, deps: PremergeDeps = defaultPremergeDeps()): Promise<PremergeSummary> {
  const { repo } = params;
  const runId = `premerge-${repo}-${now().replace(/[-:]/g, "").slice(0, 15)}`;
  let cands = premergeCandidates(db, repo, deps.now?.() ?? Date.now());
  if (params.number !== undefined) cands = cands.filter((e) => e.number === params.number);
  const s: PremergeSummary = { runId, repo, candidates: cands.map(refOf), reviewed: 0, findings: 0, defects: 0, failed: [], moved: [] };
  if (params.limit !== undefined) cands = cands.slice(0, params.limit);
  if (params.dryRun || !cands.length) {
    log(`premerge ${repo}: ${s.candidates.length} candidates${params.dryRun ? "; dry run, nothing fetched or asked" : ""}`);
    return s;
  }
  const opusDeps: OpusDeps = { ...deps, fetchDelta: async () => ({ ok: false, tooLarge: false, error: "not used" }) };
  let handled = 0;
  await pool(cands.map((e) => async () => {
    const start = now(), ref = refOf(e), head = e.head;
    const fail = (error: string) => {
      log(`  ${ref}: ${error}`);
      savePremerge(db, { repo, number: e.number, head, at: now(), runId, model: deps.model, error });
      s.failed.push(ref);
    };
    const p = await prepareOpusInput(db, repo, candidateOf(db, e), opusDeps, log, { independent: true });
    if (p.kind === "no-diff") fail(`retry: no diff: ${p.error}`);
    else if (p.kind === "large") fail("retry: too large to review automatically");
    else if (p.kind === "no-threads") fail(`retry: ${p.error}`);
    else {
      const { input } = p;
      const checkout = (await deps.checkout?.(repo, e.number, head)) ?? undefined;
      if (checkout) input.repo_dir = REPO_PATH;
      let usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null };
      let got: PremergeReview | null = null;
      const dir = referenceDir(repo);
      const semantic: SemanticDeps | undefined = dir ? deps.semantic ?? defaultSemanticDeps(db, ref) : undefined;
      // A reply that is not valid is lint-free here: it keeps the whole-call retry. Problems of a valid one go back to the model as one fix turn.
      const lint: Lint = async (text, stage) => {
        const own = lintPremerge(text, ref);
        return own === null ? null : [...own, ...await referenceProblems(premergeTexts(text, ref), dir, semantic, { stage, otherProblems: own.length })];
      };
      for (let attempt = 0; attempt < PROMPT.limits.attempts && !got; attempt++) {
        const reply = await askClaude("premerge.opus", deps.model, [input], db, { checkout, reference: checkout ? dir : undefined, lint });
        if (!reply) continue;
        usage = add(usage, reply.usage);
        if (reply.fixTurn) log(`  ${ref}: reply lint: ${reply.problems?.length ? `${reply.problems.length} problems left after the fix turn` : "fixed by one fix turn"}`);
        got = parsePremerge(reply.text, ref, dropTexts(reply.problems));
      }
      saveUsage(db, runId, `premerge-${ref.replace("#", "-")}`, "premerge", deps.model, got ? 1 : 0, usage, start, now());
      // The call takes minutes: a push or a merge meanwhile makes the review one of a head nobody will merge.
      if (!stillHead(db, repo, e.number, head)) {
        log(`  ${ref}: the head moved during the review; not stored`);
        s.moved.push(ref);
      } else if (got) {
        savePremerge(db, { repo, number: e.number, head, at: now(), runId, model: deps.model, findings: got.findings, searched: got.searched });
        s.reviewed++; s.findings += got.findings.length; s.defects += got.findings.filter((f) => f.severity === "defect").length;
      } else fail("retry: no valid reply from the model");
    }
    params.onHandled?.(++handled);
  }), () => claudeRoom(db));
  log(`premerge ${repo}: ${s.reviewed} reviewed, ${s.findings} findings (${s.defects} defects), ${s.failed.length} without an answer, ${s.moved.length} moved`);
  return s;
}
