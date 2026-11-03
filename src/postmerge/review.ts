// Post-merge review: Opus reads what a pipeline merge landed, with the pipeline's own commits and reviews of the PR, and
// lists defects and minor findings. One review per merged PR. Reads GitHub (the merged diff); writes only to the local
// database. Filing the defects is src/postmerge/file.ts.
import type { DatabaseSync } from "node:sqlite";
import { claudeRoom } from "../agents/call.ts";
import { add, askClaude, pool, saveUsage, type Usage } from "../classify/run.ts";
import { audit } from "../dash/audit.ts";
import { CLAUDE_PROMPTS } from "../prompts/index.ts";
import { referenceDir } from "../reference.ts";
import { defaultSemanticDeps, referenceProblems, type SemanticDeps } from "../reference-lint.ts";
import { dropTexts, type Lint } from "../replylint.ts";
import { codeDiff, ghMerged, type MergedFetcher } from "../review/diff.ts";
import { MAX_DIFF_CHARS } from "../review/opus.ts";
import { REPO_PATH } from "../sandbox/command.ts";
import { checkoutForCommit, checkoutForPr } from "../sandbox/index.ts";
import { lintReply, MAX_MERGED_DIFF_CHARS, parseFindings, publicTexts, type Finding, type PostmergeCommit, type PostmergePr, type PostmergeReviewRow, type RelatedItem } from "./parse.ts";
import { mergedPr, selectPostmerge, type MergedPr } from "./select.ts";

const PROMPT = CLAUDE_PROMPTS["postmerge.opus"];
const now = () => new Date().toISOString();
const refOf = (c: { repo: string; number: number }) => `${c.repo}#${c.number}`;

export type PostmergeParams = {
  repo: string; limit?: number;
  /** Review these PRs of the repo whether or not they have a review (the `--again` command). */
  only?: number[];
  onHandled?: (n: number) => void;
};
export type PostmergeDeps = {
  fetchMerged: MergedFetcher; model: string; maxChars: number;
  /** Host directory with a read-only checkout of `sha` for a sandboxed call, or null to ask without tools. Absent: no tools. `head` is the PR's last head, the fallback when GitHub names no merge commit. */
  checkout?: (repo: string, number: number, sha: string | null, head: string) => Promise<string | null>;
  semantic?: SemanticDeps;
};
export type PostmergeSummary = { runId: string; repo: string; candidates: number; reviewed: number; findings: number; defects: number; failed: string[] };

export function defaultPostmergeDeps(db: DatabaseSync): PostmergeDeps {
  return {
    fetchMerged: ghMerged, model: PROMPT.models[0]!, maxChars: Math.min(MAX_DIFF_CHARS, MAX_MERGED_DIFF_CHARS),
    checkout: async (repo, number, sha, head) => {
      if (!sha) return checkoutForPr(repo, number, head, console.log);
      const { branchOf } = await import("../fixissue/index.ts");
      return checkoutForCommit(repo, branchOf(db, repo), sha, console.log);
    },
  };
}

/** Commits the pipeline added to the PR: conflict merges, fix-ups and parts carried over from duplicates, oldest first. */
function pipelineCommits(db: DatabaseSync, repo: string, number: number): PostmergeCommit[] {
  const rows = [
    ...(db.prepare("SELECT to_head AS sha, created_at AS at, reason AS note FROM conflict_merges WHERE repo = ? AND number = ? AND state = 'merged'").all(repo, number) as { sha: string | null; at: string; note: string | null }[])
      .map((r) => ({ ...r, kind: "conflict-merge" as const, note: r.note ?? "merged the base branch into the PR" })),
    ...(db.prepare("SELECT to_head AS sha, created_at AS at, reason AS note FROM fixups WHERE repo = ? AND number = ? AND state = 'pushed'").all(repo, number) as { sha: string | null; at: string; note: string | null }[])
      .map((r) => ({ ...r, kind: "fix-up" as const, note: r.note ?? "pushed the fixes of the review" })),
    ...(db.prepare("SELECT to_head AS sha, updated_at AS at, outcome AS note FROM dupe_carries WHERE repo = ? AND number = ? AND outcome LIKE 'pushed%'").all(repo, number) as { sha: string | null; at: string; note: string | null }[])
      .map((r) => ({ ...r, kind: "duplicate-carry" as const, note: "carried parts of closed duplicates onto the PR" })),
  ];
  return rows.sort((a, b) => a.at.localeCompare(b.at)).map(({ kind, sha, note }) => ({ kind, sha, note }));
}

function reviewHistory(db: DatabaseSync, repo: string, number: number): PostmergeReviewRow[] {
  const list = <T>(s: string | null): T[] => { try { const v = JSON.parse(s ?? "[]") as unknown; return Array.isArray(v) ? (v as T[]) : []; } catch { return []; } };
  return (db.prepare("SELECT head_oid, at, verdict, sure, reason, risks, fixes FROM opus_review_history WHERE repo = ? AND number = ? AND verdict IS NOT NULL ORDER BY at, rowid").all(repo, number) as
    { head_oid: string; at: string; verdict: string; sure: number; reason: string; risks: string | null; fixes: string | null }[])
    .map((r) => ({ head: r.head_oid, verdict: r.verdict, sure: r.sure === 1, reason: r.reason, risks: list<string>(r.risks), fixes: list(r.fixes), at: r.at }));
}

/** Open items of the repo that mention the PR by number or one of its files by path: number, kind and title, for deduplication. */
export function relatedOpen(db: DatabaseSync, repo: string, number: number, files: string[]): RelatedItem[] {
  const needles = [`#${number}`, ...files.slice(0, 30)];
  const where = needles.map(() => "(i.title LIKE ? ESCAPE '\\' OR i.body LIKE ? ESCAPE '\\')").join(" OR ");
  const args = needles.flatMap((n) => { const like = `%${n.replace(/[\\%_]/g, "\\$&")}%`; return [like, like]; });
  const rows = db.prepare(`SELECT i.number, i.kind, i.title, i.body FROM items i WHERE i.repo = ? AND i.state = 'OPEN' AND i.number <> ? AND (${where}) ORDER BY i.number LIMIT 60`).all(repo, number, ...args) as
    { number: number; kind: "issue" | "pr"; title: string | null; body: string | null }[];
  const byNumber = new RegExp(String.raw`(?<![\w/])#${number}(?!\d)`);
  return rows
    .filter((r) => { const text = `${r.title ?? ""}\n${r.body ?? ""}`; return byNumber.test(text) || files.some((f) => text.includes(f)); })
    .slice(0, 40).map((r) => ({ number: r.number, kind: r.kind, title: (r.title ?? "").slice(0, 160) }));
}

type Prepared = { kind: "ready"; input: PostmergePr; sha: string | null } | { kind: "error"; error: string };

async function prepare(db: DatabaseSync, c: MergedPr, deps: PostmergeDeps): Promise<Prepared> {
  const d = await deps.fetchMerged(c.repo, c.number);
  if (!d.ok) return { kind: "error", error: d.tooLarge ? "held: too large to review automatically" : `retry: no merged diff: ${d.error}` };
  let cd = codeDiff(d.text);
  if (!cd.files.length && cd.testsOmitted.length) cd = codeDiff(d.text, true);
  if (!cd.files.length) return { kind: "error", error: "held: the merge changed no code files" };
  if (cd.text.length > deps.maxChars) return { kind: "error", error: "held: too large to review automatically" };
  const it = db.prepare("SELECT title, body, author FROM items WHERE repo = ? AND number = ?").get(c.repo, c.number) as { title: string | null; body: string | null; author: string | null } | undefined;
  const input: PostmergePr = {
    ref: refOf(c), title: it?.title ?? "", body: it?.body ?? "", author: it?.author ?? null, merge_sha: d.sha ?? c.head_oid, method: c.method,
    files: cd.files, tests_omitted: cd.testsOmitted, lockfiles_omitted: cd.lockfilesOmitted,
    pipeline_commits: pipelineCommits(db, c.repo, c.number), review_history: reviewHistory(db, c.repo, c.number),
    related_open: relatedOpen(db, c.repo, c.number, cd.files), diff: cd.text,
  };
  return { kind: "ready", input, sha: d.sha };
}

/**
 * Stores the review and one `postmerge_followups` row for each finding that is never filed: a minor one (skipped-minor)
 * or a defect another open item already covers (skipped-duplicate). A review that replaces an earlier one keeps the
 * earlier one's follow-up rows, so a defect filed before is not filed again.
 */
export function saveReview(db: DatabaseSync, c: { repo: string; number: number }, r: { sha: string; runId: string | null; model: string | null; findings: Finding[] | null; error: string | null; at?: string }): void {
  const at = r.at ?? now();
  // A failed second try never replaces a stored review.
  if (r.error && db.prepare("SELECT 1 FROM postmerge_reviews WHERE repo = ? AND number = ? AND error IS NULL").get(c.repo, c.number)) return;
  db.prepare("INSERT OR REPLACE INTO postmerge_reviews (repo, number, merge_sha, at, model, run_id, findings, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(c.repo, c.number, r.sha, at, r.model, r.runId, r.findings ? JSON.stringify(r.findings) : null, r.error);
  const skip = db.prepare("INSERT OR IGNORE INTO postmerge_followups (repo, number, review_at, finding, title, issue_number, url, state, at) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)");
  (r.findings ?? []).forEach((f, i) => {
    if (f.severity === "minor") skip.run(c.repo, c.number, at, i, f.title, "skipped-minor", at);
    else if (f.duplicate_of !== null) skip.run(c.repo, c.number, at, i, f.title, "skipped-duplicate", at);
  });
}

export async function runPostmerge(db: DatabaseSync, params: PostmergeParams, log: (line: string) => void = console.log, deps: PostmergeDeps = defaultPostmergeDeps(db)): Promise<PostmergeSummary> {
  const { repo } = params;
  const runId = `postmerge-${repo}-${now().replace(/[-:]/g, "").slice(0, 15)}`;
  let cands: MergedPr[] = params.only ? params.only.flatMap((n) => { const m = mergedPr(db, repo, n); return m ? [m] : []; }) : selectPostmerge(db, repo);
  const s: PostmergeSummary = { runId, repo, candidates: cands.length, reviewed: 0, findings: 0, defects: 0, failed: [] };
  if (params.limit !== undefined) cands = cands.slice(0, params.limit);
  if (!cands.length) { log(`postmerge ${repo}: nothing to review`); return s; }
  let handled = 0;
  await pool(cands.map((c) => async () => {
    const start = now();
    const p = await prepare(db, c, deps);
    if (p.kind === "error") {
      log(`  ${refOf(c)}: ${p.error}`);
      saveReview(db, c, { sha: c.head_oid, runId, model: null, findings: null, error: p.error });
      params.onHandled?.(++handled);
      return;
    }
    const { input } = p;
    const checkout = (await deps.checkout?.(repo, c.number, p.sha, c.head_oid)) ?? undefined;
    if (checkout) input.repo_dir = REPO_PATH;
    let usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null };
    let got: Finding[] | null = null;
    const dir = referenceDir(repo);
    const semantic = dir ? deps.semantic ?? defaultSemanticDeps(db, input.ref) : undefined;
    // A reply that is not valid is lint-free here: it keeps the whole-call retry. Problems of a valid one go back to the model as one fix turn.
    const lint: Lint = async (text, stage) => {
      const own = lintReply(text);
      return own === null ? null : [...own, ...await referenceProblems(publicTexts(text), dir, semantic, { stage, otherProblems: own.length })];
    };
    for (let attempt = 0; attempt < PROMPT.limits.attempts && !got; attempt++) {
      const reply = await askClaude("postmerge.opus", deps.model, [input], db, { checkout, reference: checkout ? dir : undefined, lint });
      if (!reply) continue;
      usage = add(usage, reply.usage);
      if (reply.fixTurn) log(`  ${refOf(c)}: reply lint: ${reply.problems?.length ? `${reply.problems.length} problems left after the fix turn` : "fixed by one fix turn"}`);
      got = parseFindings(reply.text, dropTexts(reply.problems));
    }
    if (got) {
      saveReview(db, c, { sha: input.merge_sha, runId, model: deps.model, findings: got, error: null });
      s.reviewed++; s.findings += got.length; s.defects += got.filter((f) => f.severity === "defect").length;
    } else {
      log(`  ${refOf(c)}: no valid post-merge review`);
      saveReview(db, c, { sha: input.merge_sha, runId, model: deps.model, findings: null, error: "retry: no valid reply from the model" });
      s.failed.push(refOf(c));
    }
    params.onHandled?.(++handled);
    saveUsage(db, runId, `postmerge-${refOf(c).replace("#", "-")}`, "postmerge", deps.model, got ? 1 : 0, usage, start, now());
  }), () => claudeRoom(db));
  log(`postmerge ${repo}: ${s.reviewed} reviewed, ${s.findings} findings (${s.defects} defects), ${s.failed.length} without an answer`);
  return s;
}

export function queueBackfill(db: DatabaseSync, by: string, since: string): number {
  const iso = new Date(since).toISOString();
  db.prepare("INSERT INTO settings (key, value) VALUES ('postmerge_since', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(iso);
  audit(db, by, "postmerge-backfill", null, { since: iso });
  return (db.prepare(`SELECT COUNT(*) AS n FROM (SELECT DISTINCT m.repo, m.number FROM merges m WHERE m.outcome = 'merged' AND m.at >= ?
    AND NOT EXISTS (SELECT 1 FROM postmerge_reviews r WHERE r.repo = m.repo AND r.number = m.number))`).get(iso) as { n: number }).n;
}
