// The fix PR of a red default branch: for each `needs-fix` row of an approved repo whose head is still red, one attempt
// (per repo, head and check): skip when main is green again or an open PR already covers the failure, otherwise the CI fix
// patch path writes a patch against the head commit (Sonnet, Opus check, validators), the commit is pushed to the
// pipeline account's fork on `autocraft/main-ci-<check>-<sha7>` and a PR is opened against the default branch.
// The log, the files and other PRs are untrusted data; nothing from them is run here.
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { ORG } from "../act/templates.ts";
import { errorFiles, patchFromFailure, type CifixDeps } from "../cifix/index.ts";
import { readFailure } from "../cifix/logs.ts";
import { forkOf } from "../fixissue/index.ts";
import { outsideShown } from "../fixup/excerpt.ts";
import { Git, type Exec } from "../fixup/git.ts";
import { scrubReason, whoAmI } from "../fixup/index.ts";
import { ghOpenPr, pushBranch } from "../github/write.ts";
import { MAIN_FIX_BRANCH_PREFIX } from "../mainci/index.ts";
import type { Gh } from "../merge/safe-merge.ts";
import { cleanLine } from "../review/post-template.ts";
import type { FixRow } from "./index.ts";
import { mainFixApprovalOf } from "./approval.ts";
import { optionalChecks } from "../optional-checks.ts";

export const PR_ACTOR = "main-fix";
/** Open PRs read for overlap with the failure. */
const MAX_PRS = 30;

/** What the fix PR step needs beyond the reading and sorting deps. */
export type FixPrDeps = Pick<CifixDeps, "ask" | "check" | "root"> & {
  /** Host directory with a read-only checkout of the head commit for the sandboxed model calls, or null to ask without tools. */
  checkout?: (repo: string, branch: string, sha: string) => Promise<string | null>;
};

/** The default branch's head as the polls show it. */
export type Head = { headSha: string; branch: string; state: string; redSince: string; culprit: string; culpritPr: number | null };

type Ctx = {
  db: DatabaseSync; repo: string; gh: Gh; exec: Exec; fix: FixPrDeps; now: () => Date; log: (line: string) => void;
  /** The rows' state writer of the caller. */
  setState: (r: FixRow, state: string, reason: string | null, at: string, extra?: Partial<FixRow>) => FixRow;
  /** The head as the polls show it now. */
  current: () => Head | null;
};

/** The commit message: a subject and one line per changed file. */
const commitMessage = (subject: string, files: string[]): string => `${subject}\n\n${files.map((f) => `- ${f}`).join("\n")}\n`;
const oneLine = (s: string, max = 200): string => s.replace(/\s+/g, " ").trim().slice(0, max);
const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "check";
export const branchFor = (check: string, sha: string): string => `${MAIN_FIX_BRANCH_PREFIX}${slug(check)}-${sha.slice(0, 7)}`;
const urlOk = (url: string, repo: string): boolean => new RegExp(`^https://github\\.com/${ORG}/${repo}/pull/\\d+$`).test(url);

/** Title of the fix PR: the first check, and how many more the same patch covers. */
export const prTitle = (checks: string[]): string => `Fix main CI: ${cleanLine(checks[0], 100)}${checks.length > 1 ? ` (+${checks.length - 1} more)` : ""}`;

/** Body of the fix PR. Fixed layout; the check names are cleaned of mentions and markup. */
export function prBody(r: { head: string; checks: { name: string; runUrl: string | null }[]; culprit: string; culpritPr: number | null; files: string[]; changed: number }): string {
  const one = (c: { name: string; runUrl: string | null }): string => `\`${cleanLine(c.name, 100).replace(/`/g, "'")}\`${c.runUrl ? ` (${c.runUrl})` : ""}`;
  return [
    `The CI of the default branch fails at ${r.head.slice(0, 8)}.`,
    "",
    r.checks.length === 1 ? `Failing check: ${one(r.checks[0]!)}` : `Failing checks:\n${r.checks.map((c) => `- ${one(c)}`).join("\n")}`,
    `Culprit: ${r.culprit.slice(0, 8)}${r.culpritPr ? ` (#${r.culpritPr})` : ""}`,
    "",
    `Patch: ${r.files.map((f) => `\`${f}\``).join(", ")}, ${r.changed} changed ${r.changed === 1 ? "line" : "lines"}.`,
  ].join("\n");
}

/**
 * The PR (number) that already covers the failure, if any: one of ours opened for this red streak and still open, or an
 * open PR updated after the red that names a failing check or changes a file the failure names.
 */
async function coveringPr(c: Ctx, checks: string[], files: string[], since: string): Promise<number | null> {
  const ours = c.db.prepare(`SELECT DISTINCT f.pr_number AS n FROM main_fixes f LEFT JOIN items i ON i.repo = f.repo AND i.number = f.pr_number
    WHERE f.repo = ? AND f.state = 'pr-opened' AND f.pr_number IS NOT NULL AND f.updated_at >= ? AND COALESCE(i.state, 'OPEN') = 'OPEN' ORDER BY f.pr_number LIMIT 1`).get(c.repo, since) as { n: number } | undefined;
  if (ours) return ours.n;
  const prs = c.db.prepare(`SELECT number, title, body FROM items WHERE repo = ? AND kind = 'pr' AND state = 'OPEN'
    AND (COALESCE(updated_at, '') > ? OR COALESCE(created_at, '') > ?) ORDER BY number LIMIT ${MAX_PRS}`).all(c.repo, since, since) as { number: number; title: string | null; body: string | null }[];
  const names = checks.map((x) => x.toLowerCase());
  for (const p of prs) {
    const text = `${p.title ?? ""}\n${p.body ?? ""}`.toLowerCase();
    if (names.some((n) => text.includes(n))) return p.number;
  }
  if (!files.length) return null;
  for (const p of prs) {
    try {
      const out = await c.gh(["api", `repos/${ORG}/${c.repo}/pulls/${p.number}/files?per_page=100`, "--jq", ".[].filename"]);
      if (out.split("\n").some((f) => files.includes(f.trim()))) return p.number;
    } catch { /* unreadable: not counted as covering */ }
  }
  return null;
}

type Outcome = "opened" | "skipped" | "failed" | "waiting";

/** One attempt for the `needs-fix` rows of one head: one patch and one PR for all of them. Each row ends in nothing-to-do, pr-opened or fix-failed, or stays needs-fix while the head is still running. */
async function attempt(c: Ctx, rows: FixRow[], count: () => void): Promise<Outcome> {
  const at = (): string => c.now().toISOString();
  const head = rows[0]!.head_sha;
  const set = (list: FixRow[], state: "nothing-to-do" | "fix-failed", reason: string): "skipped" | "failed" => {
    const why = scrubReason(oneLine(reason), c.fix.root);
    for (const r of list) c.setState(r, state, why, at());
    c.log(`  ${c.repo}: ${list.map((r) => r.check).join(", ")}: ${state}: ${why}`);
    return state === "fix-failed" ? "failed" : "skipped";
  };
  const done = (state: "nothing-to-do" | "fix-failed", reason: string) => set(rows, state, reason);
  try {
    const now = c.current();
    // The head is still being checked (a rerun is running): the row waits, with no state change and no attempt counted.
    if (now && now.headSha === head && now.state === "running") return "waiting";
    if (!now || now.state !== "red") return done("nothing-to-do", "main is green again");
    if (now.headSha !== head) return done("nothing-to-do", "main moved to a newer head");
    const reading = await readFailure(c.gh, c.repo, head, optionalChecks(c.db, c.repo));
    if (reading.kind === "skip") return done("nothing-to-do", reading.why);
    const failing = new Map(reading.failure.checks.map((x) => [x.name, x]));
    for (const r of rows.filter((x) => !failing.has(x.check))) set([r], "nothing-to-do", "the check no longer fails at this head");
    const live = rows.filter((r) => failing.has(r.check));
    if (!live.length) return "skipped";
    const checks = live.map((r) => failing.get(r.check)!);
    const files = [...new Set(checks.flatMap((x) => errorFiles(x.steps.map((s) => s.tail).join("\n"))))];
    const covered = await coveringPr(c, live.map((r) => r.check), files, now.redSince);
    if (covered !== null) return set(live, "nothing-to-do", `an open PR already covers it: #${covered}`);

    count();
    const git = new Git(c.exec, c.fix.root, c.repo);
    mkdirSync(c.fix.root, { recursive: true });
    if (!(await git.fetchBranch(ORG, c.repo, now.branch, head))) return set(live, "fix-failed", "the head commit is no longer in the repository");
    const ref = `${c.repo}@${head.slice(0, 8)}`;
    const names = live.map((r) => r.check);
    const title = prTitle(names);
    const made = await patchFromFailure(c.db, c.fix, {
      git, ref, title, repo: c.repo, number: 0, head, round: 1, failure: { head, checks }, diffText: "",
      runId: `main-fix-${c.repo}-${at().replace(/[-:]/g, "").slice(0, 15)}`, actor: PR_ACTOR, at,
      reviewReason: `The default branch fails the check${names.length > 1 ? "s" : ""} ${names.join(", ")} at this head. The patch must make ${names.length > 1 ? "them" : "it"} pass without changing what the code is meant to do.`,
      checkout: async () => c.fix.checkout?.(c.repo, now.branch, head),
    });
    if (!made.ok) return set(live, "fix-failed", made.reason);
    const { v, shown } = made;
    const scratch = mkdtempSync(join(c.fix.root, ".index-"));
    let applied;
    try { applied = await git.applyToTree(head, v.patch, join(scratch, "index"), shown.flatMap((f) => ("excerpt" in f ? [f.path] : []))); }
    finally { rmSync(scratch, { recursive: true, force: true }); }
    if (!applied.ok) return set(live, "fix-failed", applied.reason);
    const refusal = await made.check(v.patch);
    if (refusal !== null) return set(live, "fix-failed", refusal.replace(/^rejected: /, ""));

    const who = await whoAmI(c.exec);
    c.db.prepare("INSERT INTO main.settings (key, value) VALUES ('pipeline_login', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(who.login);
    const commit = await git.commit(applied.tree, head, commitMessage(title, v.files), { name: who.login, email: who.email });
    const changes = await git.rawChanges(head, commit);
    const touched = changes.map((x) => x[3]!).sort().join("\n");
    if (changes.some((x) => x[2] !== "M" || x[0] !== x[1] || (x[0] !== "100644" && x[0] !== "100755")) || touched !== [...v.files].sort().join("\n"))
      return set(live, "fix-failed", "the commit would change files or modes outside the validated diff");
    const outside = outsideShown(shown, await git.diffText(head, commit));
    if (outside) return set(live, "fix-failed", outside);

    // The model calls took minutes: the approval and the head are read again before anything is written.
    const again = c.current();
    if (!mainFixApprovalOf(c.db, c.repo)) return set(live, "fix-failed", "fixing a red main is no longer approved");
    if (!again || again.state !== "red" || again.headSha !== head) return set(live, "nothing-to-do", "main changed while the patch was written");

    const branch = branchFor(names[0]!, head);
    const fork = await forkOf({ db: c.db, login: PR_ACTOR }, c.exec, who.login, c.repo);
    const owner = fork.split("/")[0]!;
    const found = await c.exec("gh", ["pr", "list", "--repo", `${ORG}/${c.repo}`, "--state", "open", "--head", branch, "--json", "url,headRepositoryOwner", "--jq", `.[] | select(.headRepositoryOwner.login == "${owner}") | .url`]);
    let url = found.code === 0 ? found.stdout.trim().split("\n")[0] ?? "" : "";
    if (!(url && urlOk(url, c.repo))) {
      const push = await pushBranch({ db: c.db, login: PR_ACTOR }, git, "main-fix-push", { repo: c.repo, remote: fork, branch, sha: commit }, { fork, head });
      if (push.code !== 0) return set(live, "fix-failed", `push failed: ${oneLine(push.stderr)}`);
      const body = prBody({ head, checks: live.map((r) => ({ name: r.check, runUrl: r.run_url })), culprit: now.culprit, culpritPr: now.culpritPr, files: v.files, changed: v.changed });
      const pr = await ghOpenPr({ db: c.db, login: PR_ACTOR }, c.exec, "main-fix-pr", { repo: c.repo, target: ref, base: now.branch, head: `${owner}:${branch}`, title, body },
        { by: "model", kind: "pull request", model: made.model }, { branch, files: v.files });
      url = pr.stdout.trim().split("\n").pop() ?? "";
      if (pr.code !== 0 || !urlOk(url, c.repo)) return set(live, "fix-failed", `the pull request was not opened: ${oneLine(pr.stderr || pr.stdout)}`);
    }
    for (const r of live) c.setState(r, "pr-opened", r.reason, at(), { pr_number: Number(url.split("/").pop()), pr_url: url });
    c.log(`  ${c.repo}: ${names.join(", ")}: opened ${url}`);
    return "opened";
  } catch (e) {
    return done("fix-failed", String((e as Error).message ?? e));
  }
}

/** Takes the repo's `needs-fix` rows head by head; `onHandled` is called once per head that reaches the model work. */
export async function openFixPrs(c: Ctx, onHandled?: () => void): Promise<{ opened: number; skipped: number; failed: number }> {
  const out = { opened: 0, skipped: 0, failed: 0 };
  const rows = c.db.prepare("SELECT * FROM main_fixes WHERE repo = ? AND state = 'needs-fix' AND verdict = 'code' ORDER BY created_at, head_sha, \"check\"").all(c.repo) as FixRow[];
  const byHead = new Map<string, FixRow[]>();
  for (const r of rows) (byHead.get(r.head_sha) ?? byHead.set(r.head_sha, []).get(r.head_sha)!).push(r);
  for (const group of byHead.values()) {
    if (!mainFixApprovalOf(c.db, c.repo)) break;
    const o = await attempt(c, group, () => onHandled?.());
    if (o !== "waiting") out[o]++;
  }
  return out;
}
