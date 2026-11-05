import { test } from "node:test";
import assert from "node:assert/strict";
import { postCandidates } from "../src/review/post.ts";
import { T0, T1, world } from "./world-db.ts";

test("a review carried over our fix-up is posted with the source review's points, naming both heads", () => {
  const w = world().repo().pr(1, { head: "bbbbbbb2222" }).review(1, { head: "aaaaaaa1111", verdict: "take-fix" });
  const pub = JSON.stringify({ summary: "The change is right; one call can fail.", points: ["`src/net.rs:42`: send() unwraps the result."] });
  w.db.prepare("UPDATE opus_reviews SET public_review = ?, model = 'claude-opus-5-5' WHERE repo = 'app' AND number = 1").run(pub);
  w.db.prepare(`INSERT INTO opus_reviews (repo, number, head_oid, at, model, mode, base_head, verdict, sure, reason) VALUES ('app', 1, 'bbbbbbb2222', ?, 'carried', 'carried', 'aaaaaaa1111', 'take', 1, 'carried')`).run(T1);
  assert.ok(T0 < T1);
  const c = postCandidates(w.db, "app");
  assert.equal(c.length, 1);
  assert.equal(c[0]!.head_oid, "bbbbbbb2222");
  assert.equal(c[0]!.model, "claude-opus-5-5");
  assert.equal(c[0]!.opusAt, T1);
  const body = c[0]!.body;
  assert.match(body, /^Small fixes needed, made in bbbbbbb:/);
  assert.match(body, /send\(\) unwraps the result/);
  assert.match(body, /Recommendation: (merge|wait)/);
  assert.doesNotMatch(body, /after the fixes above/);
  assert.match(body, /Reviewed at aaaaaaa\. Fixes pushed in bbbbbbb\.$/);
});
