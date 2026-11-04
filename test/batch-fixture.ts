import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { connect } from "../src/db.ts";
import type { Querier } from "../src/mirror.ts";
import type { BatchDeps } from "../src/merge/batch.ts";
import { SCRATCH } from "./scratch.ts";
import { validating } from "./gql.ts";
import { seedPremergeClean } from "./helpers/premerge.ts";

mkdirSync(SCRATCH, { recursive: true });
export const dir = mkdtempSync(join(SCRATCH, "batch-test-"));
export const T0 = "2026-01-01T00:00:00Z";
export const T1 = "2026-01-02T00:00:00Z";
export const MAIN = "a".repeat(40);
export const MAIN2 = "b".repeat(40);

export function fresh(prs: { n: number; author?: string }[]): DatabaseSync {
  const db = connect(join(mkdtempSync(join(dir, "db-")), "t.db"));
  db.exec("INSERT OR IGNORE INTO tracked_repos (name, pipeline) VALUES ('app', 1)");
  for (const p of prs) {
    db.prepare(`INSERT INTO items (repo, number, kind, state, title, author, additions, deletions, head_oid, created_at, updated_at) VALUES ('app', ?, 'pr', 'OPEN', ?, ?, 20, 0, ?, '${T0}', '${T0}')`).run(p.n, `PR ${p.n}`, p.author ?? "regular", `sha${p.n}`);
    db.prepare(`INSERT INTO classifications (repo, number, classifier, run_id, at, type_label, flags, probs) VALUES ('app', ?, 'jev', 'r1', '${T0}', 'bugfix', '[]', '{"top":0.95}')`).run(p.n);
    db.prepare(`INSERT INTO opus_reviews (repo, number, head_oid, run_id, at, model, verdict, reason, fixes, sure, mode) VALUES ('app', ?, ?, 'rv', '${T0}', 'm', 'take', 'ok', NULL, 1, 'full')`).run(p.n, `sha${p.n}`);
    db.prepare(`INSERT INTO verifications (repo, number, head_sha, kind, reason, state, created_at) VALUES ('app', ?, ?, 'tests', 'r', 'passed', '${T0}')`).run(p.n, `sha${p.n}`);
    seedPremergeClean(db, 'app', p.n, `sha${p.n}`);
    db.prepare(`INSERT INTO pr_checks (repo, number, head_oid, state, is_draft, overall, checks, mergeable, maintainer_can_modify, fetched_at) VALUES ('app', ?, ?, 'OPEN', 0, 'success', '[]', 'MERGEABLE', 1, '${T1}')`).run(p.n, `sha${p.n}`);
  }
  db.prepare("INSERT INTO whitelist_overrides (login, status, by, at) VALUES ('regular', 'allow', 'op', ?)").run(T0);
  db.prepare("INSERT INTO main.settings (key, value) VALUES ('merge_approved:app', ?)").run(JSON.stringify({ by: "op", at: T0 }));
  return db;
}

export type World = { log: string[]; conflicts: Set<string>; mainHead: string; ci: "SUCCESS" | "FAILURE" | "PENDING"; mergeExit: number; tip: Map<string, string>;
  /** Head commits and states GitHub reports instead of the defaults (`sha<n>`, OPEN); 900 is the batch PR. */
  heads: Map<number, string>; prState: Map<number, string>; existingPr: string;
  /** Called whenever a single PR is read, with its number: lets a test change the database between a stage's calls. */
  onRead?: (n: number) => void };
export const world = (): World => ({ log: [], conflicts: new Set(), mainHead: MAIN, ci: "SUCCESS", mergeExit: 0, tip: new Map(), heads: new Map(), prState: new Map(), existingPr: "" });

export function deps(w: World, root: string): BatchDeps {
  let commits = 0;
  const querier: Querier = validating({
    spent: 0, remaining: 5000,
    async query(query: string, vars: object) {
      if (query.includes("reviewThreads")) return { repository: { pullRequest: { author: null, comments: { nodes: [] }, reviews: { nodes: [] }, reviewThreads: { nodes: [] } } } };
      const v = vars as { n?: number };
      if (query.includes("viewer")) return { viewer: { login: "bot", id: "U1" } };
      if (query.startsWith("mutation")) return { addAssigneesToAssignable: {} };
      const head = (n: number) => w.heads.get(n) ?? (n === 900 ? w.tip.get("tip") ?? "none" : `sha${n}`);
      if (v.n !== undefined) { w.onRead?.(v.n); }
      if (v.n !== undefined) return { repository: { pullRequest: { id: `PR${v.n}`, headRefOid: head(v.n), state: w.prState.get(v.n) ?? "OPEN", assignees: { nodes: [] }, commits: { totalCount: 1, nodes: [] } } } };
      // A failing CI is the batch PR's (#900); its members keep a green rollup.
      const ciOf = (x: number) => (x !== 900 && w.ci === "FAILURE" ? "SUCCESS" : w.ci);
      const nums = [...query.matchAll(/pullRequest\(number: (\d+)\)/g)].map((m) => Number(m[1]));
      return { repository: Object.fromEntries(nums.map((x) => [`pr${x}`, {
        number: x, state: w.prState.get(x) ?? "OPEN", isDraft: false, headRefOid: head(x), mergeable: "MERGEABLE", maintainerCanModify: true,
        commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [{ __typename: "CheckRun", name: "ci", status: ciOf(x) === "PENDING" ? "IN_PROGRESS" : "COMPLETED", conclusion: ciOf(x) === "PENDING" ? null : ciOf(x) }] } } } }] },
      }])) };
    },
  });
  return {
    querier, root, mergeCommand: "safe-merge-test", now: () => new Date(T1),
    mainHead: async () => w.mainHead,
    async run(cmd, args) { w.log.push(`${cmd} ${args.join(" ")}`); return { code: w.mergeExit, stdout: "", stderr: w.mergeExit ? "not mergeable" : "" }; },
    async exec(cmd, args, opts) {
      const a = [...args];
      if (cmd === "git") { while (a[0] === "-c") a.splice(0, 2); }
      const key = [cmd, ...a.slice(0, 2)].join(" ");
      const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
      if (cmd === "git") {
        if (a[0] === "rev-parse" && a[1] === "--git-dir") return ok(".\n");
        if (a[0] === "fetch") return ok();
        if (a[0] === "rev-parse") return ok((a[1] === "refs/batch/main" ? w.mainHead : `sha${a[1]!.split("pr-")[1]}`) + "\n");
        if (a[0] === "merge-tree") {
          const b = a[a.length - 1]!;
          return w.conflicts.has(b) ? { code: 1, stdout: "", stderr: "" } : ok(`tree-${a[a.length - 2]}-${b}\n`);
        }
        if (a[0] === "commit-tree") { const c = `commit${++commits}`; w.log.push(`commit-tree ${a.filter((x) => x.startsWith("sha") || x.startsWith("commit") || /^a+$/.test(x) || /^b+$/.test(x)).join(" ")}`); w.tip.set("tip", c); return ok(`${c}\n`); }
        if (a[0] === "diff") return ok("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n");
        if (a[0] === "push") { w.log.push(`push ${a.slice(-2).join(" ")}`); return ok(); }
      }
      if (cmd === "gh") {
        if (key === "gh api user") return ok(JSON.stringify({ login: "bot", id: 7, node_id: "N7" }));
        if (a[0] === "api") return ok("storytold/app\n");
        if (a[0] === "pr" && a[1] === "list") return ok(w.existingPr);
        if (a[0] === "pr" && a[1] === "create") { w.log.push(`pr create ${opts?.input?.split("\n").filter((l) => l.startsWith("- ")).join(" ")}`); return ok("https://github.com/storytold/app/pull/900\n"); }
        if (a[0] === "pr" && a[1] === "close") { w.log.push(`pr close ${a[2]}`); return ok(); }
      }
      throw new Error(`unexpected ${cmd} ${a.join(" ")}`);
    },
  };
}
