// Post-merge review: Opus reads what a pipeline merge landed, with the pipeline's own commits and reviews of the PR, and
// lists defects and minor findings. One review per merged PR. Reads GitHub (the merged diff); writes only to the local
// database. Filing the defects is src/postmerge/file.ts.
import type { DatabaseSync } from "node:sqlite";
import { claudeRoom } from "../agents/call.ts";
import { pool } from "../classify/run.ts";
import { runModelStep } from "../agents/step.ts";
import { POSTMERGE_OPUS } from "../agents/steps.ts";
import { audit } from "../dash/audit.ts";
import { CLAUDE_PROMPTS } from "../prompts/index.ts";
import { referenceDir } from "../reference.ts";
import { defaultSemanticDeps, type SemanticDeps } from "../reference-lint.ts";
import { codeDiff, ghMerged, type MergedFetcher } from "../review/diff.ts";
import { MAX_DIFF_CHARS } from "../review/opus.ts";
import { REPO_PATH } from "../sandbox/command.ts";
import { checkoutForCommit, checkoutForPr } from "../sandbox/index.ts";
import { MAX_MERGED_DIFF_CHARS, type FiledBefore, type Finding, type PostmergeCommit, type PostmergePr, type PostmergeReviewRow, type RelatedItem } from "./parse.ts";
import { followupsOf, MAX_RETRIES, mergedPr, selectPostmerge, type MergedPr } from "./select.ts";

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
    ...(db.prepare("SELECT to_head AS sha, created_at AS at, reason AS note FROM ci_fixes WHERE repo = ? AND number = ? AND state = 'pushed'").all(repo, number) as { sha: string | null; at: string; note: string | null }[])
      .map((r) => ({ ...r, kind: "ci-fix" as const, note: r.note ?? "pushed a fix for the failing CI check" })),
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

/** Items closed within this long still count as related: a defect reported and closed recently is not reported again. */
export const RELATED_CLOSED_DAYS = 30;

/** Items of the repo, open or closed in the last 30 days, that mention the PR by number or one of its files by path: number, kind, state and title, for deduplication. */
export function relatedOpen(db: DatabaseSync, repo: string, number: number, files: string[], at = Date.now()): RelatedItem[] {
  const needles = [`#${number}`, ...files.slice(0, 30)];
  const where = needles.map(() => "(i.title LIKE ? ESCAPE '\\' OR i.body LIKE ? ESCAPE '\\')").join(" OR ");
  const args = needles.flatMap((n) => { const like = `%${n.replace(/[\\%_]/g, "\\$&")}%`; return [like, like]; });
  const since = new Date(at - RELATED_CLOSED_DAYS * 86400_000).toISOString();
  const rows = db.prepare(`SELECT i.number, i.kind, i.state, i.title, i.body FROM items i WHERE i.repo = ?
    AND (i.state = 'OPEN' OR COALESCE(i.closed_at, i.merged_at, i.updated_at) >= ?) AND i.number <> ? AND (${where}) ORDER BY i.number LIMIT 60`).all(repo, since, number, ...args) as
    { number: number; kind: "issue" | "pr"; state: string; title: string | null; body: string | null }[];
  const byNumber = new RegExp(String.raw`(?<![\w/])#${number}(?!\d)`);
  return rows
    .filter((r) => { const text = `${r.title ?? ""}\n${r.body ?? ""}`; return byNumber.test(text) || files.some((f) => text.includes(f)); })
    .slice(0, 40).map((r) => ({ number: r.number, kind: r.kind, state: r.state === "OPEN" ? "open" as const : "closed" as const, title: (r.title ?? "").slice(0, 160) }));
}

/** Follow-up issues earlier reviews of the PR filed, with their current state; one still in `filing` has an unknown outcome. */
export function filedBefore(db: DatabaseSync, repo: string, number: number): FiledBefore[] {
  const stateOf = db.prepare("SELECT state FROM items WHERE repo = ? AND number = ?");
  return followupsOf(db, repo, number).filter((f) => f.state === "filed" || f.state === "filing").map((f) => {
    const it = f.issue_number === null ? undefined : stateOf.get(repo, f.issue_number) as { state: string } | undefined;
    return { number: f.issue_number, state: f.state === "filing" ? "unknown" as const : it?.state === "OPEN" || !it ? "open" as const : "closed" as const, title: f.title };
  });
}

type Prepared = { kind: "ready"; input: PostmergePr; sha: string | null } | { kind: "error"; error: string };

async function prepare(db: DatabaseSync, c: MergedPr, deps: PostmergeDeps): Promise<Prepared> {
  const d = await deps.fetchMerged(c.repo, c.number, { batch: c.batch === 1 });
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
    related_open: relatedOpen(db, c.repo, c.number, cd.files), filed_before: filedBefore(db, c.repo, c.number), diff: cd.text,
  };
  return { kind: "ready", input, sha: d.sha };
}

/**
 * Stores the review and one `postmerge_followups` row for each finding that is never filed: a minor one (skipped-minor)
 * or a defect another item already covers (skipped-duplicate). A review that replaces an earlier one keeps the earlier
 * one's follow-up rows, so the PR's filed follow-ups stay known. A `retry:` error is stored as held at the third try.
 */
export function saveReview(db: DatabaseSync, c: { repo: string; number: number }, r: { sha: string; runId: string | null; model: string | null; findings: Finding[] | null; error: string | null; at?: string }): void {
  const at = r.at ?? now();
  // A failed second try never replaces a stored review.
  if (r.error && db.prepare("SELECT 1 FROM postmerge_reviews WHERE repo = ? AND number = ? AND error IS NULL").get(c.repo, c.number)) return;
  let error = r.error, tries = 0;
  if (error?.startsWith("retry:")) {
    tries = ((db.prepare("SELECT tries FROM postmerge_reviews WHERE repo = ? AND number = ?").get(c.repo, c.number) as { tries: number } | undefined)?.tries ?? 0) + 1;
    if (tries >= MAX_RETRIES) error = `held: gave up after ${tries} tries (${error.slice("retry:".length).trim()})`;
  }
  db.prepare("INSERT OR REPLACE INTO postmerge_reviews (repo, number, merge_sha, at, model, run_id, findings, error, tries) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(c.repo, c.number, r.sha, at, r.model, r.runId, r.findings ? JSON.stringify(r.findings) : null, error, tries);
  const skip = db.prepare("INSERT OR IGNORE INTO postmerge_followups (repo, number, review_at, finding, title, issue_number, url, state, at, duplicate_of) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)");
  (r.findings ?? []).forEach((f, i) => {
    if (f.severity === "minor") skip.run(c.repo, c.number, at, i, f.title, "skipped-minor", at, null);
    else if (f.duplicate_of !== null) skip.run(c.repo, c.number, at, i, f.title, "skipped-duplicate", at, f.duplicate_of);
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
    const dir = referenceDir(repo);
    const semantic = dir ? deps.semantic ?? defaultSemanticDeps(db, input.ref) : undefined;
    const r = await runModelStep(db, POSTMERGE_OPUS, input, {
      model: deps.model, checkout, reference: checkout ? dir : undefined, ctx: { dir, semantic },
      usage: { run: runId, agent: `postmerge-${refOf(c).replace("#", "-")}`, stage: "postmerge", items: (ok) => (ok ? 1 : 0) },
      onReply: (reply) => { if (reply.fixTurn) log(`  ${refOf(c)}: reply lint: ${reply.problems?.length ? `${reply.problems.length} problems left after the fix turn` : "fixed by one fix turn"}`); },
    });
    const got: Finding[] | null = r.ok ? r.value : null;
    if (got) {
      saveReview(db, c, { sha: input.merge_sha, runId, model: deps.model, findings: got, error: null });
      s.reviewed++; s.findings += got.length; s.defects += got.filter((f) => f.severity === "defect").length;
    } else {
      log(`  ${refOf(c)}: no valid post-merge review`);
      saveReview(db, c, { sha: input.merge_sha, runId, model: deps.model, findings: null, error: "retry: no valid reply from the model" });
      s.failed.push(refOf(c));
    }
    params.onHandled?.(++handled);
  }), () => claudeRoom(db));
  log(`postmerge ${repo}: ${s.reviewed} reviewed, ${s.findings} findings (${s.defects} defects), ${s.failed.length} without an answer`);
  return s;
}

/** A backfill reaching further back than this needs the operator's confirmation. */
export const BACKFILL_FREE_DAYS = 14;

export function queueBackfill(db: DatabaseSync, by: string, since: string, o: { yes?: boolean; now?: number } = {}): number {
  const iso = new Date(since).toISOString();
  const days = ((o.now ?? Date.now()) - Date.parse(iso)) / 86400_000;
  if (days > BACKFILL_FREE_DAYS && !o.yes) throw new Error(`--since is ${Math.floor(days)} days back; every merged PR since then gets a model review and its defects are filed publicly. Add --yes to confirm`);
  db.prepare("INSERT INTO settings (key, value) VALUES ('postmerge_since', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(iso);
  audit(db, by, "postmerge-backfill", null, { since: iso, confirmed: o.yes === true });
  return (db.prepare(`SELECT COUNT(*) AS n FROM (SELECT DISTINCT m.repo, m.number FROM merges m WHERE m.outcome = 'merged' AND m.at >= ?
    AND NOT EXISTS (SELECT 1 FROM postmerge_reviews r WHERE r.repo = m.repo AND r.number = m.number))`).get(iso) as { n: number }).n;
}
