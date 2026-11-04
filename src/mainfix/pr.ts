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
const commitMessage = (check: string, files: string[]): string => `Fix main CI: ${cleanLine(check, 100)}\n\n${files.map((f) => `- ${f}`).join("\n")}\n`;
const oneLine = (s: string, max = 200): string => s.replace(/\s+/g, " ").trim().slice(0, max);
const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "check";
export const branchFor = (check: string, sha: string): string => `${MAIN_FIX_BRANCH_PREFIX}${slug(check)}-${sha.slice(0, 7)}`;
const urlOk = (url: string, repo: string): boolean => new RegExp(`^https://github\\.com/${ORG}/${repo}/pull/\\d+$`).test(url);

/** Body of the fix PR. Fixed layout; the check name is cleaned of mentions and markup. */
export function prBody(r: { head: string; check: string; runUrl: string | null; culprit: string; culpritPr: number | null; files: string[]; changed: number }): string {
  const check = cleanLine(r.check, 100).replace(/`/g, "'");
  return [
    `The CI of the default branch fails at ${r.head.slice(0, 8)}.`,
    "",
    `Failing check: \`${check}\`${r.runUrl ? ` (${r.runUrl})` : ""}`,
    `Culprit: ${r.culprit.slice(0, 8)}${r.culpritPr ? ` (#${r.culpritPr})` : ""}`,
    "",
    `Patch: ${r.files.map((f) => `\`${f}\``).join(", ")}, ${r.changed} changed ${r.changed === 1 ? "line" : "lines"}.`,
  ].join("\n");
}

/** The open PR (number) updated after the red that names the check or touches the files the failure names, if any. */
async function coveringPr(c: Ctx, check: string, files: string[], since: string): Promise<number | null> {
  const prs = c.db.prepare(`SELECT number, title, body FROM items WHERE repo = ? AND kind = 'pr' AND state = 'OPEN'
    AND (COALESCE(updated_at, '') > ? OR COALESCE(created_at, '') > ?) ORDER BY number LIMIT ${MAX_PRS}`).all(c.repo, since, since) as { number: number; title: string | null; body: string | null }[];
  const name = check.toLowerCase();
  for (const p of prs) if (`${p.title ?? ""}\n${p.body ?? ""}`.toLowerCase().includes(name)) return p.number;
  if (!files.length) return null;
  for (const p of prs) {
    try {
      const out = await c.gh(["api", `repos/${ORG}/${c.repo}/pulls/${p.number}/files?per_page=100`, "--jq", ".[].filename"]);
      if (out.split("\n").some((f) => files.includes(f.trim()))) return p.number;
    } catch { /* unreadable: not counted as covering */ }
  }
  return null;
}

/** One attempt for a `needs-fix` row. The row ends in nothing-to-do, pr-opened or fix-failed. */
async function attempt(c: Ctx, row: FixRow, count: () => void): Promise<"opened" | "skipped" | "failed"> {
  const at = (): string => c.now().toISOString();
  const done = (state: "nothing-to-do" | "fix-failed", reason: string): "skipped" | "failed" => {
    const why = scrubReason(oneLine(reason), c.fix.root);
    c.setState(row, state, why, at());
    c.log(`  ${c.repo}: ${row.check}: ${state}: ${why}`);
    return state === "fix-failed" ? "failed" : "skipped";
  };
  try {
    const now = c.current();
    if (!now || now.state !== "red") return done("nothing-to-do", "main is green again");
    if (now.headSha !== row.head_sha) return done("nothing-to-do", "main moved to a newer head");
    const reading = await readFailure(c.gh, c.repo, row.head_sha);
    if (reading.kind === "skip") return done("nothing-to-do", reading.why);
    const check = reading.failure.checks.find((x) => x.name === row.check);
    if (!check) return done("nothing-to-do", "the check no longer fails at this head");
    const failure = { head: row.head_sha, checks: [check] };
    const files = errorFiles(check.steps.map((s) => s.tail).join("\n"));
    const covered = await coveringPr(c, row.check, files, now.redSince);
    if (covered !== null) return done("nothing-to-do", `an open PR already covers it: #${covered}`);

    count();
    const git = new Git(c.exec, c.fix.root, c.repo);
    mkdirSync(c.fix.root, { recursive: true });
    if (!(await git.fetchBranch(ORG, c.repo, now.branch, row.head_sha))) return done("fix-failed", "the head commit is no longer in the repository");
    const ref = `${c.repo}@${row.head_sha.slice(0, 8)}`;
    const made = await patchFromFailure(c.db, c.fix, {
      git, ref, title: `Fix main CI: ${cleanLine(row.check, 100)}`, repo: c.repo, number: 0, head: row.head_sha, round: 1, failure, diffText: "",
      runId: `main-fix-${c.repo}-${at().replace(/[-:]/g, "").slice(0, 15)}`, actor: PR_ACTOR, at,
      checkout: async () => c.fix.checkout?.(c.repo, now.branch, row.head_sha),
    });
    if (!made.ok) return done("fix-failed", made.reason);
    const { v, shown } = made;
    const scratch = mkdtempSync(join(c.fix.root, ".index-"));
    let applied;
    try { applied = await git.applyToTree(row.head_sha, v.patch, join(scratch, "index"), shown.flatMap((f) => ("excerpt" in f ? [f.path] : []))); }
    finally { rmSync(scratch, { recursive: true, force: true }); }
    if (!applied.ok) return done("fix-failed", applied.reason);
    const refusal = await made.check(v.patch);
    if (refusal !== null) return done("fix-failed", refusal.replace(/^rejected: /, ""));

    const who = await whoAmI(c.exec);
    c.db.prepare("INSERT INTO main.settings (key, value) VALUES ('pipeline_login', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(who.login);
    const commit = await git.commit(applied.tree, row.head_sha, commitMessage(row.check, v.files), { name: who.login, email: who.email });
    const changes = await git.rawChanges(row.head_sha, commit);
    const touched = changes.map((x) => x[3]!).sort().join("\n");
    if (changes.some((x) => x[2] !== "M" || x[0] !== x[1] || (x[0] !== "100644" && x[0] !== "100755")) || touched !== [...v.files].sort().join("\n"))
      return done("fix-failed", "the commit would change files or modes outside the validated diff");
    const outside = outsideShown(shown, await git.diffText(row.head_sha, commit));
    if (outside) return done("fix-failed", outside);

    // The model calls took minutes: the approval and the head are read again before anything is written.
    const again = c.current();
    if (!mainFixApprovalOf(c.db, c.repo)) return done("fix-failed", "fixing a red main is no longer approved");
    if (!again || again.state !== "red" || again.headSha !== row.head_sha) return done("nothing-to-do", "main changed while the patch was written");

    const branch = branchFor(row.check, row.head_sha);
    const fork = await forkOf({ db: c.db, login: PR_ACTOR }, c.exec, who.login, c.repo);
    const owner = fork.split("/")[0]!;
    const found = await c.exec("gh", ["pr", "list", "--repo", `${ORG}/${c.repo}`, "--state", "open", "--head", branch, "--json", "url,headRepositoryOwner", "--jq", `.[] | select(.headRepositoryOwner.login == "${owner}") | .url`]);
    let url = found.code === 0 ? found.stdout.trim().split("\n")[0] ?? "" : "";
    if (!(url && urlOk(url, c.repo))) {
      const push = await pushBranch({ db: c.db, login: PR_ACTOR }, git, "main-fix-push", { repo: c.repo, remote: fork, branch, sha: commit }, { fork, head: row.head_sha });
      if (push.code !== 0) return done("fix-failed", `push failed: ${oneLine(push.stderr)}`);
      const body = prBody({ head: row.head_sha, check: row.check, runUrl: row.run_url, culprit: now.culprit, culpritPr: now.culpritPr, files: v.files, changed: v.changed });
      const pr = await ghOpenPr({ db: c.db, login: PR_ACTOR }, c.exec, "main-fix-pr", { repo: c.repo, target: ref, base: now.branch, head: `${owner}:${branch}`, title: `Fix main CI: ${cleanLine(row.check, 100)}`, body },
        { by: "model", kind: "pull request", model: made.model }, { branch, files: v.files });
      url = pr.stdout.trim().split("\n").pop() ?? "";
      if (pr.code !== 0 || !urlOk(url, c.repo)) return done("fix-failed", `the pull request was not opened: ${oneLine(pr.stderr || pr.stdout)}`);
    }
    c.setState(row, "pr-opened", row.reason, at(), { pr_number: Number(url.split("/").pop()), pr_url: url });
    c.log(`  ${c.repo}: ${row.check}: opened ${url}`);
    return "opened";
  } catch (e) {
    return done("fix-failed", String((e as Error).message ?? e));
  }
}

/** Takes the repo's `needs-fix` rows one by one; `handled` counts the attempts against the step's daily limit. */
export async function openFixPrs(c: Ctx, onHandled?: () => void): Promise<{ opened: number; skipped: number; failed: number }> {
  const out = { opened: 0, skipped: 0, failed: 0 };
  const rows = c.db.prepare("SELECT * FROM main_fixes WHERE repo = ? AND state = 'needs-fix' AND verdict = 'code' ORDER BY created_at, head_sha, \"check\"").all(c.repo) as FixRow[];
  for (const row of rows) {
    if (!mainFixApprovalOf(c.db, c.repo)) break;
    out[await attempt(c, row, () => onHandled?.())]++;
  }
  return out;
}
