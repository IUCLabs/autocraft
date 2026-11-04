import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { useTestAccount } from "./accounts-fixture.ts";
import { createEnv, hello } from "../src/build/envs.ts";
import { claim, createTask, getTask, warmKeyOf } from "../src/build/tasks.ts";
import { setRunner, type Runner } from "../src/classify/run.ts";
import { connect } from "../src/db.ts";
import { claudeArgs, claudeParts, renderClaude } from "../src/prompts/index.ts";
import { selectCandidates } from "../src/verify/select.ts";
import { cratesFromTree, packageName } from "../src/verify/crates.ts";
import { runVerify, type VerifyDeps } from "../src/verify/index.ts";
import { parsePlanReply, patchFor, patchProblem, regressionPath } from "../src/verify/plan.ts";
import { queueTasks, queueWarmBuild, tasksFor } from "../src/verify/tasks.ts";
import type { VerifyPlanInput } from "../src/verify/types.ts";
import { SCRATCH } from "./scratch.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "verify-test-"));
process.env.AUTOCRAFT_DIFF_CACHE = join(dir, "diffs");
process.env.AUTOCRAFT_ARTIFACT_DIR = join(dir, "artifacts");

const T0 = "2026-01-01T00:00:00Z";
const sha = (n: number, tag = "a") => `${tag}${n}`.padStart(40, "0");
const BASE = "b".repeat(40);
const MAIN = "d".repeat(40);
const CRATES = [{ name: "core-lib", dir: "crates/core" }, { name: "app", dir: "." }];

function fresh() {
  process.env.AUTOCRAFT_DIFF_CACHE = mkdtempSync(join(dir, "cache-"));
  const db = connect(join(mkdtempSync(join(dir, "db-")), "t.db"));
  db.exec("INSERT OR IGNORE INTO tracked_repos (name, pipeline) VALUES ('app', 1)");
  useTestAccount(db);
  db.exec("INSERT INTO repos (name, visibility, default_branch) VALUES ('app', 'public', 'main'), ('priv', 'internal', 'main')");
  const pr = db.prepare(`INSERT INTO items (repo, number, kind, state, title, body, is_draft, additions, deletions, changed_files, head_oid, created_at, updated_at)
    VALUES (?, ?, 'pr', 'OPEN', ?, 'body', ?, 10, 0, 1, ?, '${T0}', '${T0}')`);
  const jev = db.prepare(`INSERT INTO classifications (repo, number, classifier, run_id, at, type_label, flags, probs) VALUES (?, ?, 'jev', 'r1', '${T0}', ?, '[]', '{"top":0.95}')`);
  const review = db.prepare(`INSERT INTO opus_reviews (repo, number, head_oid, run_id, at, model, verdict, reason, risks, sure, mode) VALUES (?, ?, ?, 'rv', '${T0}', 'sonnet', ?, 'fine', '["r"]', 1, 'full')`);
  const add = (n: number, o: { repo?: string; verdict?: string; label?: string; draft?: boolean; reviewedAt?: string } = {}) => {
    const repo = o.repo ?? "app";
    pr.run(repo, n, `PR ${n}`, o.draft ? 1 : 0, sha(n));
    jev.run(repo, n, o.label ?? "bugfix");
    review.run(repo, n, o.reviewedAt ?? sha(n), o.verdict ?? "take");
  };
  add(1);
  add(2, { verdict: "take-fix" });
  add(3, { reviewedAt: sha(3, "e") }); // reviewed at an older head
  add(4);
  add(5);
  add(6, { draft: true });
  add(7, { repo: "priv" });
  add(8, { label: "infra" });
  add(9, { verdict: "hold" });
  db.prepare(`INSERT INTO verifications (repo, number, head_sha, kind, reason, state, created_at) VALUES ('app', 4, ?, 'tests', 'x', 'planned', '${T0}')`).run(sha(4));
  const checks = db.prepare(`INSERT INTO pr_checks (repo, number, head_oid, state, is_draft, overall, checks, fetched_at) VALUES ('app', ?, ?, 'OPEN', 0, ?, '[]', '2026-02-01T00:00:00Z')`);
  checks.run(5, sha(5), "failure");
  // CI result of an older head, fetched before the mirror last saw the PR change
  db.prepare(`INSERT INTO pr_checks (repo, number, head_oid, state, is_draft, overall, checks, fetched_at) VALUES ('app', 8, ?, 'OPEN', 0, 'failure', '[]', '2025-12-01T00:00:00Z')`).run(sha(8, "e"));
  checks.run(1, sha(1), "pending");
  return db;
}

describe("verify warm keys", () => {
  test("warm keys are valid for any repo name", () => {
    for (const [name, key] of [["app", "app"], ["Craft_Libs.rs", "craft-libs-rs"], ["-x--", "x"], ["___", "repo"], ["a".repeat(80), "a".repeat(64)]] as const) {
      assert.equal(warmKeyOf(name), key);
      assert.match(warmKeyOf(name), /^[a-z0-9][a-z0-9-]{0,63}$/);
    }
  });
});

describe("crate list", () => {
  test("package names and the root manifest", async () => {
    assert.equal(packageName('[workspace]\nmembers = ["a"]\n'), null);
    assert.equal(packageName('[package]\nname = "core-lib"\nversion = "1"\n[dependencies]\nname = "x"\n'), "core-lib");
    const blobs: Record<string, string> = { r: '[workspace]\nmembers = ["crates/*"]', c: '[package]\nname = "core-lib"' };
    const info = await cratesFromTree([
      { path: "Cargo.toml", type: "blob", sha: "r" }, { path: "crates/core/Cargo.toml", type: "blob", sha: "c" }, { path: "src", type: "tree", sha: "t" },
    ], async (s) => blobs[s]!);
    assert.deepEqual(info, { rust: true, crates: [{ name: "core-lib", dir: "crates/core" }] });
    assert.equal((await cratesFromTree([{ path: "web/Cargo.toml", type: "blob", sha: "c" }], async (s) => blobs[s]!)).rust, false);
  });
});

const reply = (o: unknown) => JSON.stringify([{ ref: "app#1", ...(o as object) }]);
const parse = (o: unknown, label: string | null = "bugfix", text?: string) => parsePlanReply(text ?? reply(o), "app#1", CRATES, label);
const TEST_FILE = "use app::f;\n#[test]\nfn regression() {\n    assert_eq!(f(), 1);\n}\n";

describe("planner reply validation", () => {
  test("accepts the three kinds and cuts the reason to 25 words", () => {
    const long = Array.from({ length: 40 }, (_, i) => `w${i}`).join(" ");
    const ci = parse({ kind: "ci-enough", reason: long });
    assert.ok(ci.ok && ci.plan.reason.split(" ").length === 25);
    const t = parse({ kind: "tests", reason: "r", crates: ["core-lib", "app", "app"], tests: ["a::b", "c_d"] });
    assert.deepEqual(t.ok && t.plan, { kind: "tests", reason: "r", crates: ["core-lib", "app"], tests: ["a::b", "c_d"] });
    const r = parse({ kind: "regression", reason: "r", crate: "core-lib", test_file: TEST_FILE });
    assert.ok(r.ok && r.plan.kind === "regression" && r.plan.dir === "crates/core");
    assert.equal(r.ok && r.plan.kind === "regression" && patchProblem(r.plan.patch, "crates/core/tests/autocraft_regression.rs"), null);
  });

  test("rejects unknown crates, bad filters, too many crates and a reply for another PR", () => {
    for (const bad of [
      { kind: "tests", reason: "r", crates: ["nope"] },
      { kind: "tests", reason: "r", crates: [] },
      { kind: "tests", reason: "r", crates: ["app", "app --release"] },
      { kind: "tests", reason: "r", crates: ["app"], tests: ["a b"] },
      { kind: "tests", reason: "r", crates: ["app"], tests: ["--nocapture"] },
      { kind: "tests", reason: "r", crates: ["app"], tests: ["x".repeat(101)] },
      { kind: "tests", reason: "r", crates: ["app"], tests: Array.from({ length: 11 }, (_, i) => `t${i}`) },
      { kind: "tests", reason: "r" },
      { kind: "weird", reason: "r" },
      { kind: "ci-enough" },
    ]) assert.equal(parse(bad).ok, false, JSON.stringify(bad));
    const many = Array.from({ length: 6 }, (_, i) => ({ name: `c${i}`, dir: `c${i}` }));
    assert.equal(parsePlanReply(reply({ kind: "tests", reason: "r", crates: many.map((c) => c.name) }), "app#1", many, null).ok, false);
    assert.equal(parsePlanReply(JSON.stringify([{ ref: "app#2", kind: "ci-enough", reason: "r" }]), "app#1", CRATES, null).ok, false);
    assert.equal(parse(null, null, "no json").ok, false);
  });

  test("regression: bugfix PRs only, listed crate, at most 200 lines", () => {
    const reg = { kind: "regression", reason: "r", crate: "core-lib", test_file: TEST_FILE };
    assert.equal(parse(reg, "infra").ok, false);
    assert.equal(parse(reg, null).ok, false);
    assert.equal(parse({ ...reg, crate: "other" }).ok, false);
    assert.equal(parse({ ...reg, test_file: "" }).ok, false);
    assert.equal(parse({ ...reg, test_file: "x\n".repeat(200) }).ok, true);
    assert.equal(parse({ ...reg, test_file: "x\n".repeat(201) }).ok, false);
    assert.equal(parsePlanReply(reply(reg), "app#1", [{ name: "core-lib", dir: "../x y" }], "bugfix").ok, false);
  });

  test("the patch check refuses anything but one new test file", () => {
    const path = regressionPath("crates/core");
    const good = patchFor("crates/core", TEST_FILE);
    assert.equal(patchProblem(good, path), null);
    assert.equal(regressionPath("."), "tests/autocraft_regression.rs");
    const other = good.replaceAll(path, "crates/core/src/lib.rs");
    assert.notEqual(patchProblem(other, path), null);
    assert.notEqual(patchProblem(good + patchFor("crates/core", "x").replaceAll(path, "build.rs"), path), null);
    assert.notEqual(patchProblem(good.replace("new file mode 100644", "deleted file mode 100644"), path), null);
    assert.notEqual(patchProblem(good.replace("--- /dev/null", "--- a/" + path), path), null);
    assert.notEqual(patchProblem(good.replace("@@ -0,0 +1,5 @@", "@@ -0,0 +1,6 @@"), path), null);
    assert.notEqual(patchProblem(good + " context\n", path), null);
    assert.notEqual(patchProblem(good.replace("+++ b/", "+++ b/../"), path), null);
    assert.notEqual(patchProblem(good.trimEnd(), path), null);
    assert.notEqual(patchProblem(patchFor("crates/core", "x\n".repeat(201)), path), null);
  });
});

describe("tasks", () => {
  const c = { repo: "app", number: 1, head: sha(1), base: BASE };

  test("tests: one head task with the crates, the filters and the warm cache in use", () => {
    const [t, ...rest] = tasksFor({ kind: "tests", reason: "r", crates: ["core-lib", "app"], tests: ["a::b"] }, c);
    assert.equal(rest.length, 0);
    assert.deepEqual(t!.requires, { os: "linux", toolchains: ["rust-stable"] });
    assert.equal(t!.step, "verify");
    assert.deepEqual([t!.headSha, t!.baseSha, t!.number], [sha(1), BASE, 1]);
    assert.deepEqual(t!.warm, { key: "app", role: "use" });
    assert.equal(t!.patch, undefined);
    const build = t!.plan.find((s) => s.name === "build")!, test = t!.plan.find((s) => s.name === "test")!;
    assert.deepEqual(build.cmd.slice(-4), ["-p", "core-lib", "-p", "app"]);
    assert.deepEqual(test.cmd.slice(-3), ["app", "--", "a::b"]);
  });

  test("regression: the same patch at the head and at the base", () => {
    const plan = { kind: "regression" as const, reason: "r", crate: "core-lib", dir: "crates/core", patch: patchFor("crates/core", TEST_FILE) };
    const [head, base, ...rest] = tasksFor(plan, c);
    assert.equal(rest.length, 0);
    assert.deepEqual([head!.headSha, base!.headSha], [sha(1), BASE]);
    assert.equal(head!.patch, plan.patch);
    assert.equal(base!.patch, plan.patch);
    assert.deepEqual(head!.warm, { key: "app", role: "use" });
    assert.deepEqual(base!.warm, { key: "app", role: "use" });
    assert.deepEqual(head!.plan.find((s) => s.name === "test")!.cmd.slice(-4), ["-p", "core-lib", "--test", "autocraft_regression"]);
  });

  test("patch and warm round-trip through createTask and claim", () => {
    const db = fresh();
    const id = "env-a";
    createEnv(db, { id, label: id, kind: "local-sandbox", slots: 4 }, "op");
    hello(db, id, { version: "1.0", capabilities: { os: "linux", arch: "x86_64", cpus: 8, memGb: 32, diskGb: 200, display: false, gpu: false, toolchains: ["rust-stable"] }, slots: 4 });
    const [plain] = [createTask(db, { step: "verify", repo: "app", headSha: sha(1), plan: [{ name: "t", cmd: ["true"], network: "none", timeoutSec: 5 }] })];
    const patch = patchFor(".", TEST_FILE);
    const withBoth = createTask(db, { step: "verify", repo: "app", headSha: sha(1), plan: [{ name: "t", cmd: ["true"], network: "none", timeoutSec: 5 }], patch, warm: { key: "app", role: "build" } });
    const got = claim(db, id, 4).tasks;
    assert.equal(got.find((t) => t.id === plain)!.patch, undefined);
    assert.equal(got.find((t) => t.id === plain)!.warm, undefined);
    assert.equal(got.find((t) => t.id === withBoth)!.patch, patch);
    assert.deepEqual(got.find((t) => t.id === withBoth)!.warm, { key: "app", role: "build" });
    assert.ok(getTask(db, withBoth));
  });

  test("createTask refuses a bad patch or warm key", () => {
    const db = fresh();
    const base = { step: "verify", repo: "app", headSha: sha(1), plan: [{ name: "t", cmd: ["true"], network: "none" as const, timeoutSec: 5 }] };
    for (const bad of [
      { patch: "" }, { patch: "x".repeat(1024 * 1024 + 1) }, { patch: "a\0b" },
      { warm: { key: "Has Upper", role: "use" as const } }, { warm: { key: "-x", role: "use" as const } }, { warm: { key: "a".repeat(65), role: "use" as const } },
      { warm: { key: "app", role: "other" as never } }, { warm: { key: "app", role: "use" as const, extra: 1 } as never },
    ]) assert.throws(() => createTask(db, { ...base, ...bad }), /patch|warm/, JSON.stringify(bad).slice(0, 60));
    createTask(db, { ...base, patch: "x".repeat(1024 * 1024), warm: { key: "a".repeat(64), role: "use" } });
  });

  test("a warm build is queued once per repo and head, and at most once a day", () => {
    const db = fresh();
    const id = queueWarmBuild(db, "app", MAIN, Date.parse("2026-03-01T00:00:00Z"));
    assert.ok(id);
    const t = db.prepare("SELECT * FROM build_tasks WHERE id = ?").get(id!) as Record<string, unknown>;
    assert.deepEqual([t.warm_key, t.warm_role, t.head_sha, t.priority, t.number], ["app", "build", MAIN, -10, null]);
    assert.ok(!(JSON.parse(t.plan as string) as { name: string }[]).some((s) => s.name === "test"));
    assert.equal(queueWarmBuild(db, "app", MAIN), null); // same head
    assert.equal(queueWarmBuild(db, "app", "e".repeat(40)), null); // within 24 hours
    assert.ok(queueWarmBuild(db, "priv", MAIN)); // another repo
    assert.equal(queueTasks(db, { kind: "tests", reason: "r", crates: ["app"], tests: [] }, { repo: "app", number: 1, head: sha(1), base: BASE }).length, 1);
  });
});

type Call = { args: string[]; input: string };
function fakeClaude(calls: Call[], answers: Record<string, unknown>): Runner {
  return async (_cmd, args, input) => {
    calls.push({ args, input });
    const ref = /"ref": "(app#\d+)"/.exec(input)![1]!;
    return { code: 0, stdout: JSON.stringify({ type: "result", result: JSON.stringify([{ ref, ...(answers[ref] as object) }]), usage: { input_tokens: 100, output_tokens: 10 } }), stderr: "" };
  };
}

const DIFF = `diff --git a/src/lib.rs b/src/lib.rs\n--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1 +1 @@\n-old\n+new\n`;
function deps(): VerifyDeps {
  return {
    fetchDiff: async () => ({ ok: true, text: DIFF }),
    fetchCrates: async () => ({ ok: true, rust: true, crates: CRATES }),
    baseOf: async () => BASE, mainHead: async () => MAIN, model: "sonnet",
  };
}
const quiet = () => {};
/** A repo whose PRs never report a check has no upstream CI, so Verify is the only check. */
const withoutCi = (db: ReturnType<typeof fresh>) => {
  db.prepare("UPDATE pr_checks SET overall = 'none'").run();
  db.prepare("DELETE FROM items WHERE number = 5").run(); // its failing CI is what made it a non-candidate
};
const TEST_DIFF = `${DIFF}diff --git a/crates/core/tests/png.rs b/crates/core/tests/png.rs\n--- a/crates/core/tests/png.rs\n+++ b/crates/core/tests/png.rs\n@@ -1 +1 @@\n-old\n+new\n`;

describe("runVerify", () => {
  test("in a repo with CI, a PR other than a bugfix with a test change is ci-enough without a model call or a task", async () => {
    const db = fresh();
    const calls: Call[] = [];
    const restore = setRunner(fakeClaude(calls, {}));
    try {
      const s = await runVerify(db, { repo: "app" }, quiet, deps());
      assert.equal(calls.length, 0);
      assert.deepEqual([s.handled, s.errors, s.tasks, s.kinds], [2, 0, [], { "ci-enough": 2 }]);
      assert.deepEqual(db.prepare("SELECT number, state FROM verifications WHERE number IN (1, 8) ORDER BY number").all().map((r) => `${r.number}:${r.state}`), ["1:ci-enough", "8:ci-enough"]);
      assert.equal((db.prepare("SELECT COUNT(*) AS n FROM build_tasks").get() as { n: number }).n, 0);
    } finally {
      restore();
    }
  });

  test("in a repo with CI, a bugfix that changes a test file is planned, and a tests answer becomes ci-enough", async () => {
    const db = fresh();
    db.prepare("DELETE FROM items WHERE number = 8").run();
    const calls: Call[] = [];
    const restore = setRunner(fakeClaude(calls, { "app#1": { kind: "tests", reason: "r", crates: ["app"] } }));
    try {
      const d = deps();
      d.fetchDiff = async () => ({ ok: true, text: TEST_DIFF });
      const s = await runVerify(db, { repo: "app" }, quiet, d);
      assert.equal(calls.length, 1);
      assert.equal(s.errors, 0);
      assert.equal((db.prepare("SELECT state FROM verifications WHERE number = 1").get() as { state: string }).state, "ci-enough");
      assert.equal((db.prepare("SELECT COUNT(*) AS n FROM build_tasks").get() as { n: number }).n, 0);
    } finally {
      restore();
    }
  });

  test("plans each candidate, queues the tasks, records the rows and queues one warm build", async () => {
    const db = fresh();
    withoutCi(db);
    const calls: Call[] = [];
    const restore = setRunner(fakeClaude(calls, {
      "app#1": { kind: "regression", reason: "bug fix with a clear symptom", crate: "core-lib", test_file: TEST_FILE },
      "app#8": { kind: "ci-enough", reason: "tooling only" },
    }));
    try {
      const s = await runVerify(db, { repo: "app" }, quiet, deps());
      assert.equal(calls.length, 2);
            const pr = (JSON.parse(calls[0]!.input.split("<pr>\n")[1]!.split("\n</pr>")[0]!)) as VerifyPlanInput;
      const parts = claudeParts("verify.plan", [pr], false);
      assert.equal(calls[0]!.input, parts.stdin);
      assert.deepEqual(calls[0]!.args, claudeArgs("verify.plan", "sonnet", false, undefined, parts.system));
      assert.deepEqual([pr.ref, pr.label, pr.crates], ["app#1", "bugfix", CRATES]);
      assert.ok(pr.diff.includes("+new"));
      assert.deepEqual([s.handled, s.errors, s.kinds], [2, 0, { regression: 1, "ci-enough": 1 }]);

      const v1 = db.prepare("SELECT * FROM verifications WHERE number = 1").get() as Record<string, unknown>;
      assert.deepEqual([v1.state, v1.kind, v1.head_sha, v1.base_sha, v1.model], ["planned", "regression", sha(1), BASE, "sonnet"]);
      const head = db.prepare("SELECT * FROM build_tasks WHERE id = ?").get(v1.head_task_id as number) as Record<string, unknown>;
      const base = db.prepare("SELECT * FROM build_tasks WHERE id = ?").get(v1.base_task_id as number) as Record<string, unknown>;
      assert.deepEqual([head.head_sha, base.head_sha, head.number, head.warm_role], [sha(1), BASE, 1, "use"]);
      assert.match(head.patch as string, /^diff --git a\/crates\/core\/tests\/autocraft_regression\.rs /);
      const v8 = db.prepare("SELECT state, head_task_id, finished_at FROM verifications WHERE number = 8").get() as Record<string, unknown>;
      assert.deepEqual([v8.state, v8.head_task_id], ["ci-enough", null]);
      assert.ok(v8.finished_at);
      assert.deepEqual(db.prepare("SELECT stage FROM stages WHERE number = 1 AND stage LIKE 'verify-%'").all().map((r) => r.stage), ["verify-planned"]);
      assert.deepEqual(db.prepare("SELECT stage FROM stages WHERE number = 8 AND stage LIKE 'verify-%'").all().map((r) => r.stage), ["verify-ci-enough"]);
      // 2 verification tasks and one warm build
      assert.equal((db.prepare("SELECT COUNT(*) AS n FROM build_tasks WHERE warm_role = 'build'").get() as { n: number }).n, 1);
      assert.equal((db.prepare("SELECT COUNT(*) AS n FROM build_tasks").get() as { n: number }).n, 3);
      assert.equal((db.prepare("SELECT sum(items) AS n FROM token_usage WHERE stage = 'verify'").get() as { n: number }).n, 2);

      // The same heads again: nothing to plan.
      const again = await runVerify(db, { repo: "app" }, quiet, deps());
      assert.equal(again.candidates, 0);
      assert.equal(calls.length, 2);
    } finally {
      restore();
    }
  });

  test("an invalid plan is an error and creates no task; the model is asked twice", async () => {
    const db = fresh();
    withoutCi(db);
    db.prepare("DELETE FROM items WHERE number = 8").run();
    const calls: Call[] = [];
    const restore = setRunner(fakeClaude(calls, { "app#1": { kind: "tests", reason: "r", crates: ["no-such-crate"] } }));
    try {
      const s = await runVerify(db, { repo: "app" }, quiet, deps());
      assert.equal(calls.length, 2);
      assert.equal(s.errors, 1);
      const v = db.prepare("SELECT state, kind, head_task_id, summary FROM verifications WHERE number = 1").get() as Record<string, unknown>;
      assert.deepEqual([v.state, v.head_task_id], ["error", null]);
      assert.match(v.summary as string, /not in the workspace/);
      assert.equal((db.prepare("SELECT COUNT(*) AS n FROM build_tasks").get() as { n: number }).n, 0);
      assert.deepEqual(db.prepare("SELECT stage FROM stages WHERE number = 1 AND stage LIKE 'verify-%'").all().map((r) => r.stage), ["verify-error"]);
    } finally {
      restore();
    }
  });

  test("a regression for a non-bugfix PR is an error", async () => {
    const db = fresh();
    withoutCi(db);
    db.prepare("DELETE FROM items WHERE number = 1").run();
    const restore = setRunner(fakeClaude([], { "app#8": { kind: "regression", reason: "r", crate: "app", test_file: TEST_FILE } }));
    try {
      const s = await runVerify(db, { repo: "app" }, quiet, deps());
      assert.equal(s.errors, 1);
      assert.match((db.prepare("SELECT summary FROM verifications WHERE number = 8").get() as { summary: string }).summary, /bugfix/);
    } finally {
      restore();
    }
  });

  test("a repo without a root Cargo.toml is not planned, calls no model and is recorded as unavailable", async () => {
    const db = fresh();
    withoutCi(db);
    const calls: Call[] = [];
    const restore = setRunner(fakeClaude(calls, {}));
    try {
      const d = deps();
      d.fetchCrates = async () => ({ ok: true, rust: false, crates: [] });
      await runVerify(db, { repo: "app" }, quiet, d);
      assert.equal(calls.length, 0);
      const states = db.prepare("SELECT DISTINCT state FROM verifications").all() as { state: string }[];
      assert.ok(states.length > 0 && states.every((r) => r.state === "unavailable" || r.state === "planned"));
      assert.deepEqual(selectCandidates(db, "app"), []); // remembered from the cached tree
    } finally {
      restore();
    }
  });
});
