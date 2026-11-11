// The login-to-account binding backfill, and issue references in posted reviews.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { backfillAuthorIds } from "../src/author-ids.ts";
import { connect } from "../src/db.ts";
import { stripLinks } from "../src/review/post-template.ts";
import { tierKey, tiersOf } from "../src/whitelist.ts";
import { SCRATCH } from "./scratch.ts";

test("backfill binds logins with merge history, and a different account under the login is not whitelisted", async () => {
  mkdirSync(SCRATCH, { recursive: true });
  const db = connect(join(mkdtempSync(join(SCRATCH, "followups-")), "m.db"));
  const ins = db.prepare("INSERT INTO items (repo, number, kind, state, title, author, created_at, merged_at) VALUES ('r', ?, 'pr', 'MERGED', 't', ?, '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z')");
  for (let i = 1; i <= 6; i++) ins.run(i, "old-dev");
  const asked: string[] = [];
  const client = { spent: 0, remaining: null, async query(q: string) { asked.push(q); return { u0: { databaseId: 42 } }; } };
  assert.equal(await backfillAuthorIds(db, client), 1);
  assert.equal(asked.length, 1);
  assert.equal(await backfillAuthorIds(db, client), 0);
  assert.equal(asked.length, 1, "nothing missing: no GitHub call");
  const tier = (id: number) => tiersOf(db, [{ login: "old-dev", id }]).get(tierKey({ login: "old-dev", id }));
  assert.equal(tier(42), "whitelisted");
  assert.equal(tier(7), "not");
});

test("review text keeps code and hex colours, and reads real references as plain numbers", () => {
  assert.equal(stripLinks("fixes #12 and acme/x#34, GH-5"), "fixes issue 12 and issue 34, issue 5");
  assert.equal(stripLinks("colour `#123456` and #12345678 and #1a2b3c"), "colour `#123456` and #12345678 and #1a2b3c");
});
