// The write module records every GitHub write (failures too) and GET /api/github-activity lists them.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { connect } from "../src/db.ts";
import { githubActivity } from "../src/dash/api/github-activity.ts";
import { addLabels, closeItem, commentOn, ghComment, mergeViaCommand, pushBranch, type Writer } from "../src/github/write.ts";
import { readSeqs } from "../src/live.ts";
import type { Querier } from "../src/mirror.ts";
import type { Req } from "../src/dash/types.ts";
import { SCRATCH } from "./scratch.ts";

mkdirSync(SCRATCH, { recursive: true });
const req = (query = "", role: "operator" | "viewer" = "operator"): Req =>
  ({ method: "GET", path: "/", params: {}, query: new URLSearchParams(query), form: new URLSearchParams(), user: { login: "op", role, canWrite: async () => true, canRead: async () => false }, csrf: "", nonce: "" });

const fakeQuerier = (fail = false): Querier & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls, spent: 0, remaining: null,
    async query(q: string) {
      calls.push(q);
      if (fail) throw new Error("graphql error: boom");
      if (q.includes("addComment")) return { addComment: { commentEdge: { node: { url: "https://github.com/storytold/app/pull/7#issuecomment-1" } } } };
      if (q.includes("addLabelsToLabelable")) return { m0: {}, m1: null };
      return {};
    },
  };
};

function setup() {
  const db = connect(join(mkdtempSync(join(SCRATCH, "ghact-")), "t.db"));
  db.prepare("INSERT OR IGNORE INTO tracked_repos (name) VALUES ('app')").run();
  db.prepare("INSERT OR IGNORE INTO tracked_repos (name) VALUES ('secret')").run();
  db.prepare("INSERT INTO repos (name, visibility) VALUES ('app', 'public')").run();
  db.prepare("INSERT INTO repos (name, visibility) VALUES ('secret', 'private')").run();
  db.prepare("INSERT INTO items (repo, number, kind, state, title) VALUES ('app', 7, 'pr', 'OPEN', 'Add the thing')").run();
  return db;
}

test("each wrapper function records its write; a failed write records the error and still throws", async () => {
  const db = setup();
  const w: Writer = { db, login: "act" };
  const q = fakeQuerier();
  const url = await commentOn(w, q, "act-comment", { repo: "app", number: 7, id: "N7" }, "Closing as a duplicate.", { decision: "d1" });
  assert.equal(url, "https://github.com/storytold/app/pull/7#issuecomment-1");
  await closeItem(w, q, { repo: "app", number: 7, id: "N7", pr: true }, { decision: "d1" });
  const bad = fakeQuerier(true);
  await assert.rejects(closeItem(w, bad, { repo: "app", number: 8, id: "N8", pr: false }, { decision: "d2" }), /boom/);

  const pushed = await pushBranch(w, { git: async () => ({ code: 0, stdout: "", stderr: "" }) }, "fixup-push", { repo: "app", number: 7, remote: "bot/app", branch: "fix", sha: "a".repeat(40), expected: "b".repeat(40) }, { run: "r1" });
  assert.equal(pushed.code, 0);
  await pushBranch(w, { git: async () => ({ code: 1, stdout: "", stderr: "denied\n403" }) }, "batch-push", { repo: "app", remote: "bot/app", branch: "integration-1", sha: "c".repeat(40) });
  await ghComment(w, async () => ({ code: 0, stdout: "https://github.com/storytold/app/pull/7#issuecomment-2\n", stderr: "" }), "fixup-comment", { repo: "app", number: 7, pr: true }, "Pushed fixes.", { run: "r1" });
  await mergeViaCommand(w, async () => ({ code: 0, stdout: `storytold/app#7 MERGED ${"d".repeat(40)} (head abc)`, stderr: "" }), "safe-merge", ["storytold/app", "7", "--squash"], { run: "r1" });
  await mergeViaCommand(w, async () => ({ code: 1, stdout: "", stderr: "REFUSED: checks not green" }), "safe-merge", ["storytold/app", "9", "--merge"]);

  const p = await githubActivity(db, req());
  assert.equal(p.total, 8);
  const by = (a: string, n?: number) => p.rows.filter((r) => r.action === a && (n === undefined || r.number === n));
  assert.equal(by("act-comment")[0]!.url, "https://github.com/storytold/app/pull/7#issuecomment-1");
  assert.equal(by("act-comment")[0]!.title, "Add the thing");
  assert.equal(by("act-comment")[0]!.source, "decision d1");
  assert.match(by("act-close", 8)[0]!.error ?? "", /boom/);
  assert.equal(by("act-close", 7)[0]!.error, null);
  assert.equal(by("fixup-push")[0]!.source, "act r1");
  assert.equal(by("fixup-push")[0]!.url, `https://github.com/bot/app/commit/${"a".repeat(40)}`);
  assert.equal(by("batch-push")[0]!.branch, "integration-1");
  assert.match(by("batch-push")[0]!.error ?? "", /denied/);
  assert.equal(by("fixup-comment")[0]!.url, "https://github.com/storytold/app/pull/7#issuecomment-2");
  assert.match(by("merge", 7)[0]!.detail, /squash ddddddd/);
  assert.equal(by("merge", 7)[0]!.url, `https://github.com/storytold/app/commit/${"d".repeat(40)}`);
  assert.match(by("merge", 9)[0]!.error ?? "", /REFUSED/);
  assert.ok(readSeqs(db).github! > 0, "the github live topic moved");
});

test("labelling writes one row per item with the label names", async () => {
  const db = setup();
  const w: Writer = { db, login: "kiri-n" };
  const done = await addLabels(w, fakeQuerier(), "app", [
    { number: 1, id: "N1", labelIds: ["L1", "L2"], names: ["bugfix", "size-S"] },
    { number: 2, id: "N2", labelIds: ["L1"], names: ["bugfix"] },
  ], undefined, { run: "run-1" });
  assert.deepEqual(done, [1]);
  const p = await githubActivity(db, req());
  assert.deepEqual(p.rows.map((r) => [r.number, r.detail, r.source, r.error === null]).sort(), [[1, "bugfix, size-S", "kiri-n run-1", true], [2, "bugfix", "kiri-n run-1", false]]);
});

test("filters, paging and visibility", async () => {
  const db = setup();
  const w: Writer = { db, login: "act" };
  const q = fakeQuerier();
  for (let n = 1; n <= 5; n++) await commentOn(w, q, "act-comment", { repo: "app", number: n, id: `N${n}` }, `c${n}`);
  await closeItem(w, q, { repo: "app", number: 3, id: "N3", pr: false });
  await commentOn(w, q, "act-comment", { repo: "secret", number: 1, id: "S1" }, "hidden");
  db.prepare("INSERT INTO audit (at, login, action, target) VALUES (?, 'op', 'sign-in', 'op')").run(new Date().toISOString());

  const all = await githubActivity(db, req());
  assert.equal(all.total, 7, "sign-ins are not GitHub writes");
  const viewer = await githubActivity(db, req("", "viewer"));
  assert.equal(viewer.total, 6, "a repo the viewer cannot read is left out");
  assert.ok(viewer.rows.every((r) => r.repo === "app"));

  const p1 = await githubActivity(db, req("repo=app&limit=4"));
  assert.equal(p1.rows.length, 4);
  assert.equal(p1.total, 6);
  assert.ok(p1.next);
  const p2 = await githubActivity(db, req(`repo=app&limit=4&after=${p1.next}`));
  assert.equal(p2.rows.length, 2);
  assert.equal(p2.next, null);
  assert.equal(new Set([...p1.rows, ...p2.rows].map((r) => r.id)).size, 6);

  assert.equal((await githubActivity(db, req("action=act-close"))).total, 1);
  assert.equal((await githubActivity(db, req("repo=app&number=3"))).total, 2);
  assert.equal((await githubActivity(db, req("from=2999-01-01"))).total, 0);
  assert.equal((await githubActivity(db, req(`to=${new Date().toISOString().slice(0, 10)}`))).total, 7);
  await assert.rejects(githubActivity(db, req("action=nope")), /unknown action/);
});
