import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPlanSet } from "../src/core/plan-set.ts";
import { isCounted, markReviewsStale, staleReviews } from "../src/review/discussion.ts";
import { setReviewMinInterval } from "../src/review/gate.ts";
import { saveOpus } from "../src/review/opus.ts";
import { parseOpusReply } from "../src/review/opus-parse.ts";
import { world } from "./world-db.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function review(w: ReturnType<typeof world>, n: number, head: string, verdict: "take" | "hold", blocked: string[] = []): void {
  saveOpus(w.db, "rv", { repo: "app", number: n, head_oid: head }, {
    mode: "full", base: null, model: "m",
    review: { ref: `app#${n}`, verdict, sure: true, reason: "r", fixes: [], risks: [], summary: null, why: null, public: null, conflicts: [], claims: [], blocked_by: blocked },
  });
}
const planOf = (w: ReturnType<typeof world>, n: number, now?: number) => loadPlanSet(w.db, now ? { now } : {}).prs.find((p) => p.facts.number === n)!.plan;
const reviews = (w: ReturnType<typeof world>, n: number) => planOf(w, n).actions.filter((a) => a.kind === "review").length;
const noGaps = (w: ReturnType<typeof world>) => { setReviewMinInterval(w.db, 0, "test"); return w; };

test("a hold review blocked by an open PR waits for it, then gets one review", () => {
  const w = noGaps(world().repo().pr(1, { head: "h1" }).pr(2));
  review(w, 1, "h1", "hold", ["app#2", "app#1", "app#99"]);
  assert.deepEqual(JSON.parse(w.db.prepare("SELECT blocked_by FROM opus_reviews WHERE number = 1").get()!.blocked_by as string), ["app#2"]);
  w.synced(1, "h2");
  assert.equal(reviews(w, 1), 0);
  assert.match(planOf(w, 1).wait ?? "", /app#2/);
  w.db.prepare("UPDATE items SET state = 'MERGED' WHERE number = 2").run();
  assert.equal(reviews(w, 1), 1);
  review(w, 1, "h2", "take");
  assert.equal(reviews(w, 1), 0);
});

test("the blocked_by of a reply is read only for a hold", () => {
  const reply = (verdict: string) => JSON.stringify({ ref: "app#1", verdict, sure: true, reason: "r", blocked_by: ["app#2", "bad", 3], claims: [] });
  assert.deepEqual(parseOpusReply(reply("hold"), "app#1")!.blocked_by, ["app#2"]);
  assert.deepEqual(parseOpusReply(reply("take"), "app#1")!.blocked_by, []);
});

test("on a reviewed head only a maintainer's comment makes the review stale; commands to bots never count", () => {
  const w = noGaps(world().repo().pr(1, { head: "h1", author: "regular" }));
  review(w, 1, "h1", "hold");
  const at = new Date(Date.now() + 5000).toISOString();
  const add = (id: string, author: string, assoc: string, body: string) => w.db.prepare(
    "INSERT INTO comments (repo, number, id, kind, author, created_at, body, counted, author_association) VALUES ('app', 1, ?, 'comment', ?, ?, ?, ?, ?)")
    .run(id, author, at, body, Number(isCounted({ author, association: assoc, prAuthor: "regular", body })), assoc);
  add("c1", "regular", "CONTRIBUTOR", "Fixed in abc123");
  assert.equal(staleReviews(w.db).has("app#1@h1"), false);
  add("c2", "maint", "MEMBER", "Please also check the parser");
  assert.equal(staleReviews(w.db).has("app#1@h1"), true);
  for (const body of ["@coderabbitai resume", "@dependabot rebase"]) {
    assert.equal(isCounted({ author: "regular", association: "CONTRIBUTOR", prAuthor: "regular", body }), false);
    assert.equal(isCounted({ author: "maint", association: "MEMBER", prAuthor: "regular", body }), false);
  }
});

test("a head is reviewed once CI at it has finished green", () => {
  const w = noGaps(world().repo().pr(1, { head: "h1" }));
  w.db.prepare("UPDATE pr_checks SET overall = 'pending' WHERE number = 1").run();
  assert.equal(reviews(w, 1), 0);
  assert.match(planOf(w, 1).wait ?? "", /CI on the latest commit/);
  w.db.prepare("UPDATE pr_checks SET overall = 'failure', checks = '[{\"name\":\"gate / test\",\"state\":\"failure\"}]' WHERE number = 1").run();
  assert.equal(reviews(w, 1), 0);
  w.db.prepare("UPDATE pr_checks SET overall = 'success', checks = '[]' WHERE number = 1").run();
  assert.equal(reviews(w, 1), 1);
});

test("the fourth review of a PR in a day waits unless a maintainer asks", async () => {
  const w = noGaps(world().repo().pr(1, { head: "h1" }));
  review(w, 1, "h1", "take"); review(w, 1, "h2", "take"); review(w, 1, "h3", "take");
  w.synced(1, "h4");
  assert.equal(reviews(w, 1), 0);
  assert.match(planOf(w, 1).wait ?? "", /review cap for today reached/);
  await sleep(5);
  markReviewsStale(w.db, "op", "app", 1);
  assert.equal(reviews(w, 1), 1);
});

test("a second review inside the minimum interval waits until it passes; Review again runs at once", async () => {
  const w = world().repo().pr(1, { head: "h1" });
  setReviewMinInterval(w.db, 120, "test");
  review(w, 1, "h1", "take");
  w.synced(1, "h2");
  assert.equal(reviews(w, 1), 0);
  assert.match(planOf(w, 1).wait ?? "", /next review after \d\d:\d\d/);
  assert.equal(reviews(w, 1) + planOf(w, 1, Date.now() + 121 * 60_000).actions.filter((a) => a.kind === "review").length, 1);
  await sleep(5);
  markReviewsStale(w.db, "op", "app", 1);
  assert.equal(reviews(w, 1), 1);
});
