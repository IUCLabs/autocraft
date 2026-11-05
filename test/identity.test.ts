// The identity map: which identity a grant carries, what the audit row records per repo setting, and that no write
// function in src/github/write.ts records a row without one.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { connect } from "../src/db.ts";
import { identityFor, identityOfDecision, repoIdentity, setRepoIdentity } from "../src/github/identity.ts";
import { closeItem } from "../src/github/write.ts";
import type { GuardedItem } from "../src/core/guard.ts";
import type { Querier } from "../src/mirror.ts";
import { SCRATCH } from "./scratch.ts";

const grant = (as: string): GuardedItem => ({ scope: "item", action: { kind: "act" }, repo: "app", number: 7, as }) as unknown as GuardedItem;
const q: Querier = { query: async () => ({}) } as unknown as Querier;

test("a decision answered by someone maps to that login, anything else to the app", () => {
  mkdirSync(SCRATCH, { recursive: true });
  const db = connect(join(SCRATCH, `identity-${process.pid}.db`));
  const ins = db.prepare("INSERT INTO decisions (id, kind, question, options, asked_at, answer, answered_by) VALUES (?, 'close', 'q', '[]', 't', ?, ?)");
  ins.run("d1", "yes", "example-user");
  ins.run("d2", null, "example-user");
  assert.equal(identityOfDecision(db, "d1"), "user:example-user");
  assert.equal(identityOfDecision(db, "d2"), "app");
  assert.equal(identityOfDecision(db, "missing"), "app");
  assert.equal(identityOfDecision(db, undefined), "app");
  assert.equal(identityFor(grant("user:example-user")), "user:example-user");
});

test("the audit row records legacy until the repo is switched, then the grant's identity", async () => {
  mkdirSync(SCRATCH, { recursive: true });
  const db = connect(join(SCRATCH, `identity-audit-${process.pid}.db`));
  db.prepare("INSERT OR IGNORE INTO tracked_repos (name) VALUES ('app')").run();
  const w = { db, login: "act" };
  const item = { repo: "app", number: 7, id: "I_1", pr: false };
  const last = () => JSON.parse((db.prepare("SELECT details FROM audit WHERE action = 'act-close' ORDER BY rowid DESC LIMIT 1").get() as { details: string }).details) as { identity: string };
  assert.equal(repoIdentity(db, "app"), "legacy");
  await closeItem(w, grant("user:example-user"), q, item);
  assert.equal(last().identity, "legacy");
  assert.equal(setRepoIdentity(db, "op", "app", "app"), true);
  await closeItem(w, grant("user:example-user"), q, item);
  assert.equal(last().identity, "user:example-user");
  await closeItem(w, grant("app"), q, item);
  assert.equal(last().identity, "app");
  assert.throws(() => setRepoIdentity(db, "op", "app", "bot"));
  assert.equal(setRepoIdentity(db, "op", "app", "legacy"), true);
  assert.equal(repoIdentity(db, "app"), "legacy");
});

test("every audited write in write.ts takes its identity from a grant", () => {
  const src = readFileSync(new URL("../src/github/write.ts", import.meta.url), "utf8");
  const calls = src.split("\n").filter((l) => /\b(recorded|viaGh)\(w, /.test(l) && !/function /.test(l));
  assert.ok(calls.length >= 25, `found ${calls.length} audited calls`);
  for (const l of calls) assert.match(l, /\b(recorded|viaGh)\(w, (idOf\(w, g\)|identity|`user:\$\{w\.login\}`), /, l.trim().slice(0, 80));
  // The rows started with begin() directly (labels, merge, command-line merge) carry the identity in their details.
  const begins = src.split("\n").filter((l) => /\bbegin\(w, /.test(l) && !/function /.test(l));
  assert.equal(begins.length, 4);
  for (const l of begins) assert.match(l, /begin\(w, (action, target, details|"labels-apply", .*det\(it\)|"merge", target, base|"merge", .*details)\)/);
  assert.match(src, /identity: idOf\(w, it\.g\)/);
  assert.match(src, /base = \{ \.\.\.details, method, identity: idOf\(w, g\) \}/);
  assert.match(src, /identity: "legacy"/);
});
