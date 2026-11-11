import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parseChecks } from "../src/review/checks.ts";
import { sensitiveReasons, CI_FILES_REASON } from "../src/core/sensitive.ts";

describe("merge hardening", () => {
  test("checks of a commit other than the PR's head are ignored", () => {
    const suite = { status: "COMPLETED", conclusion: "ACTION_REQUIRED", workflowRun: { databaseId: 9, event: "PULL_REQUEST", workflow: { name: "CI" } } };
    const commit = (oid: string) => ({ oid, checkSuites: { nodes: [suite] }, statusCheckRollup: { contexts: { nodes: [{ __typename: "CheckRun", name: "gate", status: "COMPLETED", conclusion: "SUCCESS" }] } } });
    const pr = (oid: string) => ({ number: 1, state: "OPEN", isDraft: false, headRefOid: "head", mergeable: "MERGEABLE", maintainerCanModify: false, commits: { nodes: [{ commit: commit(oid) }] } }) as never;
    const [ok] = parseChecks("app", { pr1: pr("head") });
    const [other] = parseChecks("app", { pr1: pr("older") });
    assert.deepEqual([ok!.overall, ok!.suites?.length], ["success", 1]);
    assert.deepEqual([other!.overall, other!.suites?.length], ["none", 0]);
  });

  test("a diff that edits workflows or build files needs a person's look", () => {
    const diff = (path: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-a\n+b\n`;
    for (const p of [".github/workflows/ci.yml", "crates/x/build.rs", ".cargo/config.toml"]) assert.deepEqual(sensitiveReasons(diff(p), "org"), [CI_FILES_REASON], p);
    const toml = (path: string, line: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n+${line}\n`;
    assert.deepEqual(sensitiveReasons(toml("Cargo.toml", 'serde = "1.0.200"'), "org"), []);
    assert.deepEqual(sensitiveReasons(toml("Cargo.toml", "[patch.crates-io]"), "org"), [CI_FILES_REASON]);
    assert.deepEqual(sensitiveReasons(toml("crates/x/Cargo.toml", 'y = { path = "../../../z" }'), "org"), [CI_FILES_REASON]);
    assert.deepEqual(sensitiveReasons(toml("crates/x/Cargo.toml", 'y = { path = "../y" }'), "org"), []);
    assert.deepEqual(sensitiveReasons(diff("src/lib.rs"), "org"), []);
  });
});
