// The optional reviewer app: review posts and edits mint with it when its keys are in the secrets file, everything else
// (and reviews without it) keeps the main app, and its bot counts as ours.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { connect } from "../src/db.ts";
import { reviewerAppSecretsOf } from "../src/dash/server/config.ts";
import { knownSlugs, ownLogins, setGithubIdentity } from "../src/github/identity.ts";
import { TOKEN_ENV } from "../src/github/install-token.ts";
import { closeItem, editReview, postReview } from "../src/github/write.ts";
import type { Guarded, GuardedItem } from "../src/core/guard.ts";
import { SCRATCH } from "./scratch.ts";

const MAIN = "ghs_main_app_token";
const REVIEWER = "ghs_reviewer_app_token";
const pr = { scope: "pr", action: { kind: "post-review" }, repo: "rev", number: 3, head: "a".repeat(40), as: "app" } as unknown as Guarded<"post-review">;
const item = { scope: "item", action: { kind: "act" }, repo: "rev", number: 3, as: "app" } as unknown as GuardedItem;
const note = { by: "fixed" } as never;
const box = { query: async () => { throw new Error("the box lane was used"); } } as never;

function secrets(name: string, extra: Record<string, string>): string {
  mkdirSync(SCRATCH, { recursive: true });
  const f = join(SCRATCH, name);
  writeFileSync(f, JSON.stringify({ github_app_id: "1", github_app_slug: "main-app", github_app_private_key: "k", github_app_client_id: "c", github_app_client_secret: "s", ...extra }), { mode: 0o600 });
  return f;
}

test("reviewer keys need id, slug and key; the app id signs its JWT", () => {
  assert.equal(reviewerAppSecretsOf({ github_reviewer_app_id: "9", github_reviewer_app_private_key: "k" }), null);
  assert.deepEqual(reviewerAppSecretsOf({ github_reviewer_app_id: "9", github_reviewer_app_slug: "rev-app", github_reviewer_app_private_key: "k" }), { id: "9", slug: "rev-app", privateKey: "k", clientId: "9" });
});

test("review posts and edits use the reviewer token when configured, the main token otherwise", async () => {
  process.env.AUTOCRAFT_SECRETS_FILE = secrets("no-reviewer.json", {});
  const db = connect(join(SCRATCH, `reviewer-lane-${process.pid}.db`));
  db.prepare("INSERT OR IGNORE INTO tracked_repos (name) VALUES ('rev')").run();
  setGithubIdentity(db, "op", "app");
  const seen: string[] = [];
  const appClient = (env: Record<string, string>) => ({ query: async () => { seen.push(env[TOKEN_ENV]!); return { addPullRequestReview: { pullRequestReview: { id: "R1" } } }; } });
  const main = { db, login: "review-post", mint: async () => MAIN, appClient };
  const both = { ...main, reviewerMint: async () => REVIEWER };

  assert.equal(await postReview(main, box, pr, "PR_1", note, "ok"), "R1");
  await editReview(main, box, pr, "R1", note, "ok");
  assert.deepEqual(seen.splice(0), [MAIN, MAIN]);

  assert.equal(await postReview(both, box, pr, "PR_1", note, "ok"), "R1");
  await editReview(both, box, pr, "R1", note, "ok");
  assert.deepEqual(seen.splice(0), [REVIEWER, REVIEWER]);

  // Only reviews move: a close under the same writer stays on the main app.
  await closeItem(both, item, box, { repo: "rev", number: 3, id: "I_3", pr: true });
  assert.deepEqual(seen.splice(0), [MAIN]);
});

test("the reviewer app's bot is ours and its slug is remembered", () => {
  process.env.AUTOCRAFT_SECRETS_FILE = secrets("with-reviewer.json", { github_reviewer_app_id: "9", github_reviewer_app_slug: "rev-app", github_reviewer_app_private_key: "k" });
  const db = connect(join(SCRATCH, `reviewer-own-${process.pid}.db`));
  const own = ownLogins(db, "rev");
  for (const l of ["main-app", "main-app[bot]", "rev-app", "rev-app[bot]"]) assert.ok(own.has(l), l);
  assert.deepEqual(knownSlugs(db), ["main-app", "rev-app"]);
});
