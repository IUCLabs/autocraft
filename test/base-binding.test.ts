import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { connect } from "../src/db.ts";
import { baseRefusal } from "../src/merge/base.ts";
import { cachedDiff, diffCacheDir, type DiffFetcher } from "../src/review/diff.ts";
import { SCRATCH } from "./scratch.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "base-binding-"));
process.env.AUTOCRAFT_DIFF_CACHE = join(dir, "diffs");
const HEAD = "a".repeat(40);

test("a merge is refused when the base is not the one the review read", () => {
  const db = connect(join(dir, "t.db"));
  db.prepare("INSERT INTO repos (name, default_branch) VALUES ('app', 'main')").run();
  db.prepare("INSERT INTO opus_reviews (repo, number, head_oid, at, mode, verdict, base_ref) VALUES ('app', 7, ?, 't', 'full', 'take', 'main')").run(HEAD);
  assert.equal(baseRefusal(db, "app", HEAD, 7, "main"), null);
  assert.match(baseRefusal(db, "app", HEAD, 7, "release")!, /release.*main/);
  // A review that recorded no base allows the default branch only.
  db.prepare("INSERT INTO opus_reviews (repo, number, head_oid, at, mode, verdict) VALUES ('app', 8, ?, 't', 'full', 'take')").run(HEAD);
  assert.equal(baseRefusal(db, "app", HEAD, 8, "main"), null);
  assert.ok(baseRefusal(db, "app", HEAD, 8, "release"));
});

test("a diff is stored only for the head it was fetched at, and read again for another base", async () => {
  let calls = 0;
  const moved: DiffFetcher = async () => { calls++; return { ok: false, tooLarge: false, error: "head moved" }; };
  assert.equal((await cachedDiff("app", 7, HEAD, moved)).ok, false);
  assert.equal(existsSync(join(diffCacheDir(), "app", `7-${HEAD}.diff`)), false);
  const at = (base: string): DiffFetcher => async () => { calls++; return { ok: true, text: `diff against ${base}`, base }; };
  assert.equal((await cachedDiff("app", 7, HEAD, at("main"), "main") as { text: string }).text, "diff against main");
  assert.equal((await cachedDiff("app", 7, HEAD, at("main"), "main") as { text: string }).text, "diff against main");
  assert.equal(calls, 2);
  assert.equal((await cachedDiff("app", 7, HEAD, at("release"), "release") as { text: string }).text, "diff against release");
  assert.equal(calls, 3);
});
