import assert from "node:assert/strict";
import { test } from "node:test";
import { connect } from "../src/db.ts";
import { answerAsSession, setTestRepo } from "../src/decisions.ts";

test("a session answers only on test repos, as an operator, and the audit row says so", async () => {
  const db = connect(":memory:");
  for (const r of ["sandbox", "real"]) db.prepare("INSERT INTO tracked_repos (name) VALUES (?)").run(r);
  db.prepare("INSERT INTO access (login, role) VALUES ('op', 'operator'), ('viewer', 'viewer')").run();
  const ask = db.prepare("INSERT INTO decisions (id, kind, repo, number, question, options, asked_at) VALUES (?, 'scope', ?, 1, 'Q?', ?, ?)");
  const opts = JSON.stringify([{ key: "yes", label: "Yes" }, { key: "no", label: "No" }]);
  ask.run("d-real", "real", opts, new Date().toISOString());
  ask.run("d-box", "sandbox", opts, new Date().toISOString());

  await assert.rejects(answerAsSession(db, "d-real", "yes", "op"), /not marked as a test repo/);
  setTestRepo(db, "cli", "sandbox", true);
  await assert.rejects(answerAsSession(db, "d-box", "yes", "viewer"), /not an operator/);
  await assert.rejects(answerAsSession(db, "d-box", "maybe", "op"), /option keys/);

  const d = await answerAsSession(db, "d-box", "yes", "op", "go");
  assert.equal(d.answer, "yes");
  assert.equal(d.answered_by, "op");
  const row = db.prepare("SELECT login, details FROM audit WHERE action = 'answer' AND target = 'd-box'").get() as { login: string; details: string };
  assert.equal(row.login, "op");
  assert.deepEqual([JSON.parse(row.details).source, JSON.parse(row.details).via], ["cli", "session"]);
  await assert.rejects(answerAsSession(db, "d-box", "no", "op"), /already answered/);
});
