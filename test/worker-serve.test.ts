// The worker loop against a fake coordinator and a fake container runtime.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { WorkerApi } from "../src/worker/client.ts";
import { parseWorkerConfig } from "../src/worker/config.ts";
import { backoffDelay, serve, type ServeDeps } from "../src/worker/serve.ts";
import type { ClaimedTask, TaskStep } from "../src/worker/types.ts";
import { startFakeCoordinator, type FakeCoordinator } from "./fake-coordinator.ts";
import { makeTarGz } from "./tar-util.ts";

const SCRATCH = join(homedir(), ".cache/craft-automation-scratch");
mkdirSync(SCRATCH, { recursive: true });
const root = mkdtempSync(join(SCRATCH, "worker-serve-"));
const rtDir = join(root, "rt");
mkdirSync(rtDir);
process.env.FAKE_RT_DIR = rtDir;
const FAKE = resolve(dirname(fileURLToPath(import.meta.url)), "fake-runtime.mjs");

let coord: FakeCoordinator;
let n = 0;
before(async () => {
  coord = await startFakeCoordinator();
  coord.tarballs.set("/src/a.tgz", makeTarGz([{ name: "r-a/" }, { name: "r-a/f", data: "x" }]));
});
after(async () => {
  await coord.close();
  rmSync(root, { recursive: true, force: true });
});

const task = (id: number, plan: TaskStep[]): ClaimedTask => ({ id, repo: "o/r", headSha: "b".repeat(40), baseSha: null, requires: { toolchains: ["rust-stable"] }, plan, sourceUrl: `${coord.url}/src/a.tgz` });
const step = (name: string, ops: string[]): TaskStep => ({ name, cmd: ["do", ...ops], network: "none", timeoutSec: 30 });

function harness(over: Partial<ServeDeps> = {}, slots = 2) {
  const cfg = parseWorkerConfig({ coordinatorUrl: coord.url, keyFile: "/k", workDir: join(root, `w${++n}`), slots, runtime: FAKE, images: { "rust-stable": "registry.test/rust@sha256:aa" } });
  const lines: string[] = [];
  const delays: number[] = [];
  const ac = new AbortController();
  const deps: ServeDeps = {
    cfg,
    api: new WorkerApi(coord.url, coord.key),
    version: "t",
    capabilities: () => ({ os: "linux", arch: "x86_64", cpus: 2, memGb: 4, diskGb: 100, display: false, gpu: false, toolchains: ["rust-stable"] }),
    freeDiskGb: () => 100,
    log: (l) => lines.push(l),
    sleep: (ms) => {
      delays.push(ms);
      return new Promise((r) => setTimeout(r, 15));
    },
    pollMs: 5000,
    ...over,
  };
  const done = serve(deps, ac.signal);
  return { cfg, lines, delays, ac, done, stop: async () => (ac.abort(), done) };
}
const until = async (f: () => boolean, ms = 8000) => {
  const t = Date.now();
  while (!f()) {
    if (Date.now() - t > ms) throw new Error("timeout waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe("worker loop", () => {
  test("backoff grows 5 s to 60 s", () => {
    assert.deepEqual([1, 2, 3, 4, 5, 6, 9].map(backoffDelay), [5000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
  });

  test("hello, claim, run, logs, artifacts, finish; the key is never logged", async () => {
    coord.calls.length = 0;
    const t = task(101, [step("build", ["echo:compiling", "write:out.json:{}", "exit:0"]), step("test", ["exit:0"])]);
    t.plan[0]!.artifacts = ["*.json"];
    coord.queue.push(t);
    const h = harness();
    await until(() => coord.finished.has(101));
    await h.stop();
    const fin = coord.finished.get(101)!;
    assert.equal(fin.summary, "2 steps passed");
    assert.match(coord.logs.get(101)!, /compiling/);
    assert.equal(coord.artifacts.get("101/out.json")!.toString(), "{}");
    const hello = coord.calls.find((c) => c.path === "/worker/hello")!.body as { slots: number; capabilities: { toolchains: string[] } };
    assert.equal(hello.slots, 2);
    assert.deepEqual(hello.capabilities.toolchains, ["rust-stable"]);
    assert.ok(coord.calls.some((c) => c.path === "/worker/tasks/101/start"));
    assert.equal(coord.unauthorized, 0);
    const everything = h.lines.join("\n") + JSON.stringify(coord.calls) + (coord.logs.get(101) ?? "");
    assert.ok(!everything.includes(coord.key));
    const argvs = readFileSync(join(rtDir, "calls.jsonl"), "utf8");
    assert.ok(!argvs.includes(coord.key));
  });

  test("errors are logged without the key, even when the coordinator rejects it", async () => {
    const api = new WorkerApi(coord.url, "wrong-key-xyz");
    const e = await api.claim(1, null).catch((x: Error) => x);
    assert.match((e as Error).message, /HTTP 401/);
    assert.ok(!(e as Error).message.includes("wrong-key-xyz"));
  });

  test("claim errors back off 5, 10, 20 s and the delay resets after success", async () => {
    coord.failClaims = 3;
    const h = harness();
    await until(() => h.delays.length >= 5);
    await h.stop();
    assert.deepEqual(h.delays.slice(0, 3), [5000, 10_000, 20_000]);
    assert.equal(h.delays[3], 5000); // idle poll after recovery
  });

  test("below the disk minimum it claims nothing and reports why", async () => {
    coord.calls.length = 0;
    coord.queue.push(task(102, [step("build", ["exit:0"])]));
    const h = harness({ freeDiskGb: () => 7.4 });
    await until(() => coord.calls.filter((c) => c.path === "/worker/claim").length >= 2);
    await h.stop();
    const claims = coord.calls.filter((c) => c.path === "/worker/claim").map((c) => c.body as { free: number; pausedReason: string });
    assert.ok(claims.every((c) => c.free === 0 && c.pausedReason === "disk 7 GB free (needs 20)"));
    assert.equal(coord.queue.length, 1);
    coord.queue.length = 0;
  });

  test("a task the coordinator cancels is killed and not finished", async () => {
    coord.calls.length = 0;
    coord.queue.push(task(103, [step("hang", ["sleep"])]));
    const h = harness();
    await until(() => coord.logs.get(103)?.includes("sleeping") === true);
    coord.cancel.push(103);
    await until(() => h.lines.some((l) => l.includes("task 103 cancelled")));
    await h.stop();
    assert.ok(!coord.finished.has(103));
    assert.ok(existsSync(rtDir) && readFileSync(join(rtDir, "calls.jsonl"), "utf8").includes('"kill"'));
    assert.deepEqual(h.cfg.workDir && existsSync(join(h.cfg.workDir, "task-103")), false);
  });

  test("startup removes leftover work dirs and containers", async () => {
    const orphans = join(rtDir, "orphans");
    writeFileSync(orphans, "deadbeef01\n");
    const cfgDir = join(root, `w${n + 1}`);
    mkdirSync(join(cfgDir, "task-5/src"), { recursive: true });
    const h = harness();
    await until(() => h.lines.some((l) => l.startsWith("registered")));
    await h.stop();
    rmSync(orphans);
    assert.ok(!existsSync(join(cfgDir, "task-5")));
    assert.ok(readFileSync(join(rtDir, "calls.jsonl"), "utf8").includes('["rm","-f","deadbeef01"]'));
  });
});
