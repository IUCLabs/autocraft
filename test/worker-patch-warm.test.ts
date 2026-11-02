// Task patches and warm target dirs, run through executeTask with the fake runtime.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseWorkerConfig, type WorkerConfig } from "../src/worker/config.ts";
import { executeTask, type TaskSink } from "../src/worker/executor.ts";
import { cleanWarm, readRecord, warmKeys } from "../src/worker/warm.ts";
import type { ClaimedTask, TaskStep } from "../src/worker/types.ts";
import { startFakeCoordinator, type FakeCoordinator } from "./fake-coordinator.ts";
import { makeTarGz } from "./tar-util.ts";

const SCRATCH = join(homedir(), ".cache/craft-automation-scratch");
mkdirSync(SCRATCH, { recursive: true });
const root = mkdtempSync(join(SCRATCH, "worker-warm-"));
const rtDir = join(root, "rt");
mkdirSync(rtDir);
process.env.FAKE_RT_DIR = rtDir;
const FAKE = resolve(dirname(fileURLToPath(import.meta.url)), "fake-runtime.mjs");

let coord: FakeCoordinator;
let n = 0;
const mkCfg = (over: Record<string, unknown> = {}): WorkerConfig => {
  const base = join(root, `w${++n}`);
  const c = parseWorkerConfig({
    coordinatorUrl: "http://127.0.0.1:1",
    keyFile: "/nonexistent-key",
    workDir: join(base, "work"),
    runtime: FAKE,
    images: { "rust-stable": "registry.test/rust@sha256:aa" },
    ...over,
  });
  mkdirSync(c.workDir, { recursive: true });
  mkdirSync(c.warmDir, { recursive: true });
  return c;
};
const runCalls = () => (existsSync(join(rtDir, "calls.jsonl")) ? readFileSync(join(rtDir, "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]) : []).filter((c) => c[0] === "run");
const resetCalls = () => rmSync(join(rtDir, "calls.jsonl"), { force: true });

const mkTask = (id: number, plan: TaskStep[], extra: Partial<ClaimedTask> = {}): ClaimedTask => ({ id, repo: "o/r", headSha: "a".repeat(40), baseSha: null, requires: { toolchains: ["rust-stable"] }, plan, sourceUrl: `${coord.url}/src/p.tgz`, ...extra });
const step = (ops: string[]): TaskStep => ({ name: "s", cmd: ["do", ...ops], network: "none", timeoutSec: 30 });
const sink = (): TaskSink => ({ log: async (_s, c) => void c, artifact: async () => {} });
const run = (cfg: WorkerConfig, t: ClaimedTask) => executeTask(cfg, t, sink(), new AbortController().signal, { note: (s) => console.log("NOTE", s) });

const diff = (path: string, from: string, to: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-${from}\n+${to}\n`;
const GOOD = diff("src/main.rs", "fn main(){}", "fn main(){1;}");

before(async () => {
  coord = await startFakeCoordinator();
  coord.tarballs.set("/src/p.tgz", makeTarGz([{ name: "r-aaa/" }, { name: "r-aaa/Cargo.lock", data: "x" }, { name: "r-aaa/src/main.rs", data: "fn main(){}\n" }]));
});
after(async () => {
  await coord.close();
  rmSync(root, { recursive: true, force: true });
});

describe("patch", () => {
  test("a good patch is applied before the first step", async () => {
    const cfg = mkCfg();
    const r = await run(cfg, mkTask(1, [step(["echo:ok"])], { patch: GOOD }));
    assert.equal(r.summary, "1 step passed");
  });

  test("a patch that does not apply fails the task without running steps", async () => {
    resetCalls();
    const r = await run(mkCfg(), mkTask(2, [step(["echo:ok"])], { patch: diff("src/main.rs", "something else", "x") }));
    assert.match(r.summary, /^patch does not apply: /);
    assert.equal(r.results.length, 0);
    assert.equal(runCalls().length, 0);
  });

  for (const [what, patch] of Object.entries({
    "parent path": diff("../evil", "a", "b"),
    "absolute path": diff("/etc/passwd", "a", "b"),
    "git dir": diff(".git/config", "a", "b"),
    symlink: "diff --git a/ln b/ln\nnew file mode 120000\n--- /dev/null\n+++ b/ln\n@@ -0,0 +1 @@\n+/etc/passwd\n\\ No newline at end of file\n",
    binary: "diff --git a/x.bin b/x.bin\nnew file mode 100644\nindex 0000000..1111111\nBinary files /dev/null and b/x.bin differ\n",
  })) {
    test(`refuses ${what}`, async () => {
      resetCalls();
      const r = await run(mkCfg(), mkTask(3, [step(["echo:ok"])], { patch }));
      assert.match(r.summary, /^patch refused: /);
      assert.equal(runCalls().length, 0);
    });
  }

  test("malformed patch and warm fields fail the task", async () => {
    const cfg = mkCfg();
    for (const extra of [{ patch: 5 }, { patch: "x".repeat(1024 * 1024 + 1) }, { warm: { key: "../x", role: "use" } }, { warm: { key: "ok", role: "other" } }]) {
      const r = await run(cfg, mkTask(4, [step([])], extra as unknown as Partial<ClaimedTask>));
      assert.match(r.summary, /^malformed task: /);
    }
  });
});

describe("warm target dirs", () => {
  const build = (id: number, ops: string[], role: "build" | "use" = "build", key = "repo") => mkTask(id, [step(ops)], { warm: { key, role } });
  const targetCopy = (cfg: WorkerConfig, key = "repo") => join(cfg.warmDir, key);

  test("a successful build task stores its target dir, a failed one does not", async () => {
    const cfg = mkCfg();
    const bad = await run(cfg, build(10, ["target:a.o:one", "exit:1"]));
    assert.match(bad.summary, /failed/);
    assert.deepEqual(warmKeys(cfg), []);
    const ok = await run(cfg, build(11, ["target:a.o:one"]));
    assert.equal(ok.summary, "1 step passed");
    assert.deepEqual(warmKeys(cfg), ["repo"]);
    assert.equal(readFileSync(join(targetCopy(cfg), "a.o"), "utf8"), "one");
    assert.equal(readRecord(cfg, "repo")?.commit, "a".repeat(40));
  });

  test("a failed build keeps the previous warm dir", async () => {
    const cfg = mkCfg();
    await run(cfg, build(12, ["target:a.o:old"]));
    await run(cfg, build(13, ["target:a.o:new", "exit:2"]));
    assert.equal(readFileSync(join(targetCopy(cfg), "a.o"), "utf8"), "old");
    await run(cfg, build(14, ["target:a.o:newer"]));
    assert.equal(readFileSync(join(targetCopy(cfg), "a.o"), "utf8"), "newer");
    assert.deepEqual(warmKeys(cfg), ["repo"]);
  });

  test("a use task starts from a copy and cannot change the stored dir", async () => {
    const cfg = mkCfg();
    await run(cfg, build(15, ["target:a.o:base"]));
    const r = await run(cfg, build(16, ["targetcheck:a.o:base", "target:a.o:changed", "target:b.o:extra"], "use"));
    assert.equal(r.summary, "1 step passed");
    assert.equal(readFileSync(join(targetCopy(cfg), "a.o"), "utf8"), "base");
    assert.equal(existsSync(join(targetCopy(cfg), "b.o")), false);
  });

  test("a use task without a warm dir starts empty", async () => {
    const r = await run(mkCfg(), build(17, ["targetcheck:a.o:"], "use"));
    assert.equal(r.summary, "1 step passed");
  });

  test("least recently used dirs are evicted over the cap", async () => {
    const cfg = mkCfg({ warmMaxGb: 0.0003 });
    const big = "x".repeat(120 * 1024);
    await run(cfg, build(20, [`target:a.o:${big}`], "build", "one"));
    await run(cfg, build(21, [`target:a.o:${big}`], "build", "two"));
    assert.deepEqual(warmKeys(cfg).sort(), ["one", "two"]);
    await run(cfg, build(22, ["echo:x"], "use", "one")); // touches "one"
    await run(cfg, build(23, [`target:a.o:${big}`], "build", "three"));
    assert.deepEqual(warmKeys(cfg).sort(), ["one", "three"]);
  });

  test("startup removes half-finished replacements", () => {
    const cfg = mkCfg();
    mkdirSync(join(cfg.warmDir, ".new-repo-1"));
    mkdirSync(join(cfg.warmDir, "orphan"));
    cleanWarm(cfg);
    assert.equal(existsSync(join(cfg.warmDir, ".new-repo-1")), false);
    assert.equal(existsSync(join(cfg.warmDir, "orphan")), false);
  });
});
