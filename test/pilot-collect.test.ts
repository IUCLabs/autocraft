// With a pilot set, the collect steps and the fix retry path leave other repos' fix attempts and verifications alone.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { SCRATCH } from "./scratch.ts";
import { parseRecommendReply } from "../src/decide/recommend.ts";

const { connect } = await import("../src/db.ts");
const { setFixIssueApproval } = await import("../src/fixissue/approval.ts");
const { runFixIssue, runFixIssueCollect } = await import("../src/fixissue/index.ts");
const { runCollect } = await import("../src/verify/results.ts");

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "pilot-collect-"));
const db = connect(join(dir, "p.db"));
after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

const T = "2026-01-02T00:00:00Z";
db.exec("DELETE FROM tracked_repos");
db.prepare("INSERT INTO access (login, role) VALUES ('op', 'operator')").run();
for (const repo of ["app", "other"]) {
  db.prepare("INSERT INTO repos (name, visibility, default_branch) VALUES (?, 'public', 'main')").run(repo);
  db.prepare("INSERT INTO tracked_repos (name, added_by, added_at, pipeline) VALUES (?, 'op', ?, ?)").run(repo, T, repo === "app" ? 1 : 0);
}
const attempt = db.prepare(`INSERT INTO fix_attempts (repo, number, main_sha, text_hash, state, files, crate_dir, patch, created_at, updated_at) VALUES ('other', ?, 'sha', 'h', ?, '[]', 'c', 'p', ?, ?)`);
["testing", "passed", "retry"].forEach((st, i) => attempt.run(i + 1, st, T, T));
const verif = db.prepare(`INSERT INTO verifications (repo, number, head_sha, kind, reason, state, created_at) VALUES ('other', ?, 'h', 'test', 'r', ?, ?)`);
["planned", "running"].forEach((st, i) => verif.run(i + 1, st, T));
setFixIssueApproval(db, "op", "other", true);

const snapshot = () => JSON.stringify([
  db.prepare("SELECT * FROM fix_attempts ORDER BY number").all(), db.prepare("SELECT * FROM verifications ORDER BY number").all(),
  db.prepare("SELECT count(*) AS n FROM audit").get(), db.prepare("SELECT count(*) AS n FROM build_tasks").get(),
]);
const forbidden = async (): Promise<never> => { throw new Error("called"); };
const quiet = () => {};

test("collect and retry steps ignore repos with the pipeline off", async () => {
  const before = snapshot();
  const deps = {
    exec: forbidden, ask: forbidden, mainHead: forbidden, fetchCrates: forbidden, fetchPaths: forbidden, summarise: forbidden,
    now: () => new Date(T), root: join(dir, "cache"),
  } as unknown as Parameters<typeof runFixIssueCollect>[3];
  assert.equal((await runFixIssueCollect(db, {}, quiet, deps)).looked, 0);
  const s = await runFixIssue(db, { repo: "other", dryRun: false }, quiet, deps);
  assert.deepEqual([s.started, s.queued, s.failed], [[], [], []]);
  const v = await runCollect(db, {}, quiet, { model: "m", mainHead: forbidden });
  assert.equal(v.looked, 0);
  assert.equal(snapshot(), before);
});

test("a reply with prose braces around the answer still parses", () => {
  const r = parseRecommendReply('Considering {the options}: {"recommended": "a", "reason": "fits {scope}"} Hope that helps {really}', ["a", "b"]);
  assert.deepEqual(r, { recommended: "a", reason: "fits {scope}" });
});
