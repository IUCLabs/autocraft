import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { connect } from "../src/db.ts";
import type { Querier } from "../src/mirror.ts";
import { setPushApproval } from "../src/fixup/approval.ts";
import type { Exec, ExecResult } from "../src/fixup/git.ts";
import { runFixup, type FixupDeps } from "../src/fixup/index.ts";
import { SCRATCH } from "./scratch.ts";
import { useTestAccount } from "./accounts-fixture.ts";
import { validating } from "./gql.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "fixup-pool-"));
process.env.AUTOCRAFT_DIFF_CACHE = join(dir, "diffs");
const T0 = "2026-01-01T00:00:00Z";
const FIXES = JSON.stringify([{ file: "src/lib.rs", change: "rename a to b" }]);
const head = (n: number) => String(n).repeat(40);

function setup(): DatabaseSync {
  const db = connect(join(mkdtempSync(join(dir, "db-")), "t.db"));
  useTestAccount(db);
  db.prepare("UPDATE claude_accounts SET max_concurrent = 8").run();
  db.prepare("INSERT INTO tracked_repos (name, added_by, added_at, pipeline) VALUES ('app', 'op', ?, 1)").run(T0);
  setPushApproval(db, "op", "app", true);
  for (const n of [1, 2, 3]) {
    db.prepare(`INSERT INTO items (repo, number, kind, state, title, author, additions, deletions, head_oid, head_ref, head_repo, base_ref, maintainer_can_modify, mergeable, created_at, updated_at)
      VALUES ('app', ?, 'pr', 'OPEN', 'Fix a thing', 'someone', 5, 0, ?, 'fix', 'contrib/app', 'main', 1, 'MERGEABLE', '${T0}', '${T0}')`).run(n, head(n));
    db.prepare(`INSERT INTO opus_reviews (repo, number, head_oid, run_id, at, model, verdict, reason, fixes, sure, mode) VALUES ('app', ?, ?, 'rv', '${T0}', 'm', 'take-fix', 'nearly right', ?, 1, 'full')`).run(n, head(n), FIXES);
  }
  return db;
}

/** Runs the job; the fake model call returns only once `need` calls wait at the same time. */
async function run(limit: number | undefined, need: number) {
  const db = setup();
  const querier: Querier = validating({
    spent: 0, remaining: 5000,
    async query(_q: string, v: object) {
      const n = Number((v as { n?: number }).n);
      return { repository: { pullRequest: { id: `PR${n}`, number: n, state: "OPEN", isDraft: false, headRefOid: head(n), headRefName: "fix", maintainerCanModify: true, mergeable: "MERGEABLE", headRepository: { nameWithOwner: "contrib/app" }, assignees: { nodes: [] } } } };
    },
  });
  const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: "" });
  const exec: Exec = async (cmd, args) => {
    if (cmd === "gh") return ok(JSON.stringify({ login: "pipeline-bot", id: 42, node_id: "U42" }));
    if (args.includes("--git-dir")) return ok(".\n");
    const ref = args.find((a) => /^refs\/fixup\/pr-\d+$/.test(a));
    if (args.includes("rev-parse") && ref) return ok(head(Number(ref.split("-").pop())) + "\n");
    if (args.includes("ls-tree")) return ok("100644 blob abc\tsrc/lib.rs\n");
    if (args.includes("cat-file")) return ok("fn a() {}\n");
    return ok("");
  };
  let waiting = 0, peak = 0, asked = 0;
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  const deps = {
    querier, exec, now: () => new Date(T0), root: join(dir, "cache"),
    fetchDiff: async () => ({ ok: true, text: "diff --git a/src/lib.rs b/src/lib.rs\n--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1 +1 @@\n-x\n+y\n" }),
    ask: async () => { asked++; peak = Math.max(peak, ++waiting); if (waiting >= need) open(); await Promise.race([gate, new Promise((_, no) => setTimeout(() => no(new Error("model calls did not overlap")), 5000))]); return null; },
  } as unknown as FixupDeps;
  let handled = 0;
  await runFixup(db, { repo: "app", ...(limit === undefined ? {} : { limit }), dryRun: false, onHandled: (n) => { handled = n; } }, () => {}, deps);
  return { asked, peak, handled };
}

test("a job's model calls run at the same time and its limit counts exactly", async () => {
  const all = await run(undefined, 3);
  assert.deepEqual([all.asked, all.peak, all.handled], [3, 3, 3]);
  const two = await run(2, 2);
  assert.deepEqual([two.asked, two.peak, two.handled], [2, 2, 2]);
});
