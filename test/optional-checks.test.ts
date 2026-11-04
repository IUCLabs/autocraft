// The per-repo optional-check list: storage, the first-connect seed that an operator's removal survives, and the CI fix reader.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { failedRuns } from "../src/cifix/logs.ts";
import { connect } from "../src/db.ts";
import { effectiveOverall, optionalChecks, setOptionalCheck } from "../src/optional-checks.ts";
import { SCRATCH } from "./scratch.ts";

const dir = mkdtempSync(join(SCRATCH, "optional-"));
const SONAR = "sonarcloud / SonarCloud Scan";

test("tracked repos get the SonarCloud check once; an operator's removal is not undone", () => {
  const path = join(dir, "t.db");
  const db = connect(path);
  db.exec("INSERT INTO tracked_repos (name, added_by, added_at, pipeline) VALUES ('a', 'op', 'x', 1), ('b', 'op', 'x', 1)");
  db.prepare("DELETE FROM settings WHERE key = 'optional_checks_seeded'").run();
  db.close();
  const seeded = connect(path);
  assert.deepEqual(optionalChecks(seeded, "a"), [SONAR]);
  assert.equal(setOptionalCheck(seeded, "op", "a", SONAR, false), true);
  assert.equal(setOptionalCheck(seeded, "op", "a", SONAR, false), false);
  seeded.close();
  const again = connect(path);
  assert.deepEqual(optionalChecks(again, "a"), []);
  assert.deepEqual(optionalChecks(again, "b"), [SONAR]);
  assert.deepEqual(again.prepare("SELECT action, target FROM audit ORDER BY rowid").all().map((r) => ({ ...r })), [{ action: "optional-check-remove", target: "a" }]);
});

test("effectiveOverall: only a failure of listed checks alone reads as success", () => {
  const ok = { name: "gate", state: "success" }, bad = { name: SONAR, state: "failure" };
  assert.equal(effectiveOverall("failure", [ok, bad], [SONAR]), "success");
  assert.equal(effectiveOverall("failure", [ok, bad], []), "failure");
  assert.equal(effectiveOverall("failure", [ok, bad, { name: "lint", state: "failure" }], [SONAR]), "failure");
  assert.equal(effectiveOverall("failure", [{ name: "gate", state: "pending" }, bad], [SONAR]), "pending");
  assert.equal(effectiveOverall("failure", [bad], [SONAR]), "none");
});

test("CI fix leaves listed checks out of the failures to fix", () => {
  const reply = { check_runs: [{ name: "build", status: "completed", conclusion: "failure" }, { name: SONAR, status: "completed", conclusion: "failure" }] };
  assert.deepEqual(failedRuns(reply, [SONAR]).runs.map((r) => r.name), ["build"]);
  assert.deepEqual(failedRuns(reply).runs.map((r) => r.name), ["build", SONAR]);
  assert.deepEqual(failedRuns({ check_runs: [reply.check_runs[1]!] }, [SONAR]).runs, []);
});
