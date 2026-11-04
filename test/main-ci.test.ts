// CI on the default branch: the state of a head from its checks, the culprit and red_since from the heads seen,
// and the step storing rows from a GitHub reply.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { connect } from "../src/db.ts";
import { classify, derive, prNumberOf, type HeadRow, type MainCheck } from "../src/mainci/classify.ts";
import { mainCiRepos, pollMainCi, summarize } from "../src/mainci/index.ts";
import type { Querier } from "../src/mirror.ts";
import { validating } from "./gql.ts";
import { SCRATCH } from "./scratch.ts";

const c = (name: string, state: MainCheck["state"]): MainCheck => ({ name, state, url: null });

test("classify: gate failures are red, optional failures are not, pending is running", () => {
  assert.equal(classify([]), "none");
  assert.equal(classify([c("gate / test", "success"), c("lint", "skipped")]), "green");
  assert.equal(classify([c("gate / test", "failure"), c("lint", "success")]), "red");
  assert.equal(classify([c("gate / test", "success"), c("sonar", "failure")]), "optional");
  assert.equal(classify([c("gate / test", "pending"), c("sonar", "failure")]), "running");
  assert.equal(classify([c("gate / test", "failure"), c("other", "pending")]), "red");
  assert.equal(classify([c("build", "failure")]), "red", "no gate check: any failure counts");
  assert.equal(classify([c("build", "success"), c("sonar", "failure")], ["sonar"]), "optional");
  assert.equal(classify([c("build", "failure"), c("sonar", "failure")], ["sonar"]), "red");
  assert.equal(classify([c("build", "success"), c("sonarcloud / SonarCloud Scan", "failure")], ["sonarcloud / SonarCloud Scan"]), "optional", "no gate check: only listed checks failed");
  assert.equal(classify([c("build", "success"), c("sonarcloud / SonarCloud Scan", "failure")]), "red", "unlisted");
});

test("prNumberOf reads merge commits and squash titles", () => {
  assert.equal(prNumberOf("Merge pull request #412 from fork/x"), 412);
  assert.equal(prNumberOf("Fix export (#88)"), 88);
  assert.equal(prNumberOf("Bump version"), null);
});

const row = (sha: string, state: HeadRow["state"], at: string): HeadRow => ({ sha, state, committedAt: at, headline: `Change ${sha} (#${sha.length})`, firstSeenAt: at, stateChangedAt: at });

test("derive: the culprit is the first red head after the last green one", () => {
  const d = derive([row("a", "green", "2026-01-01"), row("b", "running", "2026-01-02"), row("c", "red", "2026-01-03"), row("d", "red", "2026-01-04")])!;
  assert.equal(d.current.sha, "d");
  assert.equal(d.lastGreenSha, "a");
  assert.equal(d.culprit?.sha, "c");
  assert.equal(d.redSince, "2026-01-03");
  assert.equal(d.culprit?.pr, 1);
});

test("derive: a green head ends the red run; with no green head the oldest red head is the culprit", () => {
  const green = derive([row("a", "red", "2026-01-01"), row("b", "green", "2026-01-02")])!;
  assert.equal(green.redSince, null);
  assert.equal(green.culprit, null);
  assert.equal(green.lastGreenSha, "b");
  const never = derive([row("a", "red", "2026-01-01"), row("b", "red", "2026-01-02")])!;
  assert.equal(never.culprit?.sha, "a");
  assert.equal(never.lastGreenSha, null);
  assert.equal(derive([]), null);
});

const reply = (oid: string, nodes: object[]) => ({
  defaultBranchRef: { name: "main", target: { oid, committedDate: "2026-11-01T10:00:00Z", messageHeadline: "Merge pull request #7 from x/y", statusCheckRollup: { state: "FAILURE", contexts: { nodes } } } },
});

test("the step stores a head per repo from one query and the list derives the state", async () => {
  mkdirSync(SCRATCH, { recursive: true });
  const db = connect(join(mkdtempSync(join(SCRATCH, "mainci-")), "t.db"));
  for (const n of ["alpha", "beta", "gamma"]) {
    db.prepare("INSERT INTO repos (name, synced_at) VALUES (?, ?)").run(n, "2026-11-01T00:00:00Z");
    db.prepare("INSERT INTO tracked_repos (name, added_by, added_at) VALUES (?, 'test', '2026-11-01')").run(n);
  }
  let calls = 0;
  const q: Querier = validating({
    spent: 0, remaining: null,
    async query() {
      calls++;
      return {
        r0: reply("aaa111", [
          { __typename: "CheckRun", name: "gate / test", conclusion: "FAILURE", status: "COMPLETED", detailsUrl: "https://example.test/actions/runs/9" },
          { __typename: "StatusContext", context: "sonar", state: "SUCCESS", targetUrl: null },
        ]),
        r1: reply("bbb222", [{ __typename: "CheckRun", name: "gate / test", conclusion: "SUCCESS", status: "COMPLETED", detailsUrl: null }]),
        r2: { defaultBranchRef: null },
      };
    },
  });
  const r = await pollMainCi(db, q);
  assert.deepEqual(r, { repos: 3, heads: 2 });
  assert.equal(calls, 1);
  const list = mainCiRepos(db);
  assert.deepEqual(list.map((x) => [x.repo, x.state]), [["alpha", "red"], ["beta", "green"]]);
  assert.deepEqual(list[0]!.failing, [{ name: "gate / test", url: "https://example.test/actions/runs/9" }]);
  assert.equal(list[0]!.culprit?.pr, 7);
  assert.deepEqual(summarize(list), { green: 1, red: 1, optional: 0, running: 0, none: 0 });
});
