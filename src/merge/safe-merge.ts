// Built-in guarded merge: merges one PR only when it is open, not a draft,
// mergeable, every status check and Actions run for the head has finished
// green (or skipped/neutral), and the merge is pinned to the head that was
// checked.
//
//   craft-auto safe-merge OWNER/REPO PR --squash|--merge [--allow-pending NAME]...
//
// Exit 0 when merged, 1 on a refusal or gh failure (reason on stderr), 2 on usage.
// The decisions are pure functions over the fetched JSON; `safeMerge` is the gh layer.
import { spawn } from "node:child_process";
import { cliMergeRecorder, ghMergePr, MERGE_RECORDED_ENV } from "../github/write.ts";

export type Method = "--squash" | "--merge";
export type Gh = (args: string[]) => Promise<string>;

export type Check = { name?: string | null; context?: string | null; status?: string | null; state?: string | null; conclusion?: string | null };
export type PrView = { state: string; isDraft: boolean; mergeable: string; headRefOid: string; statusCheckRollup: Check[] };
export type Run = { name?: string | null; status?: string | null; conclusion?: string | null };
export type Commits = { author: { login: string }; commits: { authors: { login?: string | null; email?: string | null; name?: string | null }[] }[] };

const GREEN = ["SUCCESS", "SKIPPED", "NEUTRAL"];
const GREEN_RUN = ["success", "skipped", "neutral"];

/** The reason the PR may not merge on its own state and checks, or null. */
export function refuseView(v: PrView, allow: string[] = []): string | null {
  if (v.state !== "OPEN") return `state is ${v.state}`;
  if (v.isDraft !== false) return "PR is a draft";
  if (v.mergeable !== "MERGEABLE") return `mergeable is ${v.mergeable}`;
  const allowed = allow.filter((a) => a !== "");
  const rollup = v.statusCheckRollup ?? [];
  const bad: string[] = [];
  for (const c of rollup) {
    const name = c.name ?? c.context ?? "?";
    const done = (c.status ?? "COMPLETED") === "COMPLETED" && (c.state ?? "SUCCESS") !== "PENDING";
    const result = c.conclusion ?? c.state ?? "";
    if (done ? !GREEN.includes(result) : !allowed.includes(name)) bad.push(`${name}: ${done ? result : "not finished"}`);
  }
  if (bad.length) return `checks not green:\n${bad.join("\n")}`;
  if (!rollup.length) return "no checks have run";
  if (!rollup.some((c) => (c.conclusion ?? c.state) === "SUCCESS")) return "no check succeeded (only skipped or neutral)";
  return null;
}

/** The reason the head's Actions runs block the merge, or null. These cover workflows that never reach the rollup (startup failure, waiting for approval). */
export function refuseRuns(runs: Run[], allow: string[] = []): string | null {
  const bad: string[] = [];
  for (const r of runs) {
    const name = r.name ?? "";
    if (!name) continue;
    if (r.status !== "completed") {
      if (!allow.includes(name)) bad.push(`${name}: ${r.status}`);
    } else if (!GREEN_RUN.includes(r.conclusion ?? "")) bad.push(`${name}: ${r.conclusion ?? ""}`);
  }
  return bad.length ? `workflow runs not green:\n${bad.join("\n")}` : null;
}

/** Squashing another person's commits would drop their authorship, so it needs --merge. */
export function refuseAuthors(c: Commits, method: Method): string | null {
  if (method === "--merge") return null;
  const others = [...new Set(c.commits.flatMap((k) => k.authors.map((a) => a.login ?? a.email ?? a.name ?? "")))]
    .filter((a) => a !== c.author.login).sort();
  return others.length ? `commits by ${others.join(", ")}: use --merge so their commits and authorship stay` : null;
}

export function ghExec(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn("gh", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`gh ${args.slice(0, 2).join(" ")} failed: ${err.trim() || `exit code ${code}`}`))));
  });
}

export type SafeMergeResult = { merged: true; message: string } | { merged: false; reason: string };

export async function safeMerge(
  repo: string, pr: string, method: Method, allow: string[],
  gh: Gh = ghExec, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  /** Record the merge in the database (the command line; a calling pipeline stage records its own). */
  recordMerge = false,
): Promise<SafeMergeResult> {
  const refuse = (why: string): SafeMergeResult => ({ merged: false, reason: `REFUSED ${repo}#${pr}: ${why}` });
  const v = JSON.parse(await gh(["pr", "view", pr, "-R", repo, "--json", "state,isDraft,mergeable,headRefOid,statusCheckRollup"])) as PrView;
  const head = v.headRefOid;
  let why = refuseView(v, allow);
  if (why) return refuse(why);
  const runs = JSON.parse(await gh(["api", `repos/${repo}/actions/runs?head_sha=${head}&per_page=100`])) as { workflow_runs?: Run[] };
  why = refuseRuns(runs.workflow_runs ?? [], allow);
  if (why) return refuse(why);
  why = refuseAuthors(JSON.parse(await gh(["pr", "view", pr, "-R", repo, "--json", "author,commits"])) as Commits, method);
  if (why) return refuse(why);
  await ghMergePr(gh, repo, pr, method, head, recordMerge && !process.env[MERGE_RECORDED_ENV] ? cliMergeRecorder(repo, pr, method, head) : undefined);
  await sleep(3000);
  const after = JSON.parse(await gh(["pr", "view", pr, "-R", repo, "--json", "state,mergeCommit"])) as { state: string; mergeCommit?: { oid?: string } | null };
  const line = `${after.state} ${after.mergeCommit?.oid ?? ""}`;
  if (after.state !== "MERGED") return refuse(`merge command returned but state is: ${line}`);
  return { merged: true, message: `${repo}#${pr} ${line} (head ${head.slice(0, 9)}, ${v.statusCheckRollup.length} checks green)` };
}

const USAGE = "usage: craft-auto safe-merge OWNER/REPO PR --squash|--merge [--allow-pending NAME]...";

export function parseSafeMergeArgs(args: string[]): { repo: string; pr: string; method: Method; allow: string[] } | null {
  if (args.length < 3) return null;
  const [repo, pr, method, ...rest] = args as [string, string, string, ...string[]];
  if (method !== "--squash" && method !== "--merge") return null;
  const allow: string[] = [];
  for (let i = 0; i < rest.length; i += 2) {
    if (rest[i] !== "--allow-pending" || rest[i + 1] === undefined) return null;
    allow.push(rest[i + 1]!);
  }
  return { repo, pr, method, allow };
}

export const commands = {
  "safe-merge": {
    summary: "safe-merge OWNER/REPO PR --squash|--merge [--allow-pending NAME]...: merge one PR only when it is green and unchanged",
    async run(args: string[]): Promise<void> {
      const a = parseSafeMergeArgs(args);
      if (!a) { console.error(USAGE); process.exit(2); }
      try {
        const r = await safeMerge(a.repo, a.pr, a.method, a.allow, ghExec, undefined, true);
        if (r.merged) console.log(`safe-merge: ${r.message}`);
        else { console.error(`safe-merge: ${r.reason}`); process.exit(1); }
      } catch (e) {
        console.error(`safe-merge: ${(e as Error).message}`);
        process.exit(1);
      }
    },
  },
};
