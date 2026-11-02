// Worker pieces: tar extraction, container argv, executor with a fake runtime, cache, config.
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promoteCargoHome, seedCargoHome } from "../src/worker/cache.ts";
import { parseWorkerConfig, type WorkerConfig } from "../src/worker/config.ts";
import { runArgs } from "../src/worker/container.ts";
import { executeTask, removeStaleWorkDirs, type TaskSink } from "../src/worker/executor.ts";
import { rustPlan } from "../src/worker/rust.ts";
import { downloadAndExtract } from "../src/worker/tarball.ts";
import type { ClaimedTask, TaskStep } from "../src/worker/types.ts";
import { startFakeCoordinator, type FakeCoordinator } from "./fake-coordinator.ts";
import { makeTarGz } from "./tar-util.ts";

const SCRATCH = join(homedir(), ".cache/craft-automation-scratch");
mkdirSync(SCRATCH, { recursive: true });
const root = mkdtempSync(join(SCRATCH, "worker-exec-"));
const rtDir = join(root, "rt");
mkdirSync(rtDir);
process.env.FAKE_RT_DIR = rtDir;
const FAKE = resolve(dirname(fileURLToPath(import.meta.url)), "fake-runtime.mjs");

let coord: FakeCoordinator;
let n = 0;
const mkCfg = (over: Record<string, unknown> = {}): WorkerConfig => {
  const c = parseWorkerConfig({
    coordinatorUrl: "http://127.0.0.1:1",
    keyFile: "/nonexistent-key",
    workDir: join(root, `work-${++n}`),
    runtime: FAKE,
    images: { "rust-stable": "registry.test/rust@sha256:aa", "node-24": "registry.test/node@sha256:bb" },
    ...over,
  });
  mkdirSync(c.workDir, { recursive: true });
  return c;
};
const calls = (): string[][] => (existsSync(join(rtDir, "calls.jsonl")) ? readFileSync(join(rtDir, "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
const resetCalls = () => rmSync(join(rtDir, "calls.jsonl"), { force: true });
const runCalls = () => calls().filter((c) => c[0] === "run");

const TAR = "/src/default.tgz";
const mkTask = (id: number, plan: TaskStep[], tgz = TAR): ClaimedTask => ({ id, repo: "o/r", headSha: "a".repeat(40), baseSha: null, requires: { toolchains: ["rust-stable"] }, plan, sourceUrl: `${coord.url}${tgz}` });
const step = (name: string, ops: string[], extra: Partial<TaskStep> = {}): TaskStep => ({ name, cmd: ["do", ...ops], network: "none", timeoutSec: 30, ...extra });
const sink = () => {
  const logs: string[] = [];
  const arts: { name: string; bytes: number }[] = [];
  const s: TaskSink = { log: async (_s, c) => void logs.push(c), artifact: async (name, b) => void arts.push({ name, bytes: b.length }) };
  return { s, logs, arts };
};
const live = () => new AbortController().signal;

before(async () => {
  coord = await startFakeCoordinator();
  coord.tarballs.set(TAR, makeTarGz([{ name: "r-aaa/" }, { name: "r-aaa/Cargo.lock", data: "x" }, { name: "r-aaa/src/main.rs", data: "fn main(){}" }]));
});
after(async () => {
  await coord.close();
  rmSync(root, { recursive: true, force: true });
});

describe("tarball", () => {
  const extract = async (entries: Parameters<typeof makeTarGz>[0]) => {
    const dest = join(root, `x-${++n}`, "dest");
    mkdirSync(dest, { recursive: true });
    coord.tarballs.set("/src/t.tgz", makeTarGz(entries));
    const files = await downloadAndExtract(`${coord.url}/src/t.tgz`, dest, 10_000_000);
    return { dest, files };
  };

  test("strips the prefix, drops special mode bits, allows links inside the tree", async () => {
    const { dest, files } = await extract([
      { name: "p/" },
      { name: "p/a/b.txt", data: "hi", mode: 0o4755 },
      { name: "p/ln", type: "2", linkname: "a/b.txt" },
      { name: "p/a/up", type: "2", linkname: "../a/b.txt" },
      { name: "p/hard", type: "1", linkname: "p/a/b.txt" },
    ]);
    assert.equal(files, 2);
    assert.equal(readFileSync(join(dest, "a/b.txt"), "utf8"), "hi");
    assert.equal(statSync(join(dest, "a/b.txt")).mode & 0o7000, 0);
    assert.ok(lstatSync(join(dest, "ln")).isSymbolicLink());
    assert.equal(readFileSync(join(dest, "hard"), "utf8"), "hi");
  });

  for (const [what, entries] of Object.entries({
    "dot-dot": [{ name: "p/../../evil", data: "x" }],
    "absolute path": [{ name: "/etc/evil", data: "x" }],
    "symlink out": [{ name: "p/l", type: "2", linkname: "../../outside" }],
    "symlink out through a dir": [{ name: "p/a/l", type: "2", linkname: "../../x" }],
    "absolute symlink": [{ name: "p/l", type: "2", linkname: "/etc/passwd" }],
    "hardlink out": [{ name: "p/h", type: "1", linkname: "../../etc/passwd" }],
    "hardlink to nothing": [{ name: "p/h", type: "1", linkname: "p/missing" }],
    "device": [{ name: "p/dev", type: "3" }],
  })) {
    test(`rejects ${what}`, async () => {
      const dir = join(root, `y-${++n}`);
      mkdirSync(join(dir, "dest"), { recursive: true });
      coord.tarballs.set("/src/t.tgz", makeTarGz(entries));
      await assert.rejects(downloadAndExtract(`${coord.url}/src/t.tgz`, join(dir, "dest"), 10_000_000));
      assert.deepEqual(readdirSync(dir), ["dest"]); // nothing beside dest
    });
  }

  test("rejects a download over the size cap", async () => {
    coord.tarballs.set("/src/t.tgz", makeTarGz([{ name: "p/f", data: "x".repeat(100_000) }]));
    await assert.rejects(downloadAndExtract(`${coord.url}/src/t.tgz`, join(root, "never"), 50), /too large/);
  });
});

describe("container argv", () => {
  const cfg = mkCfg();
  const mounts = { src: "/w/src", target: "/w/target", cache: "/w/cache", out: "/w/out" };
  const argv = runArgs(cfg, { name: "craft-1-0-ab", image: "registry.test/rust@sha256:aa", network: "none", mounts, cmd: ["cargo", "build"] });

  test("offline step has every isolation flag", () => {
    const s = argv.join(" ");
    for (const f of ["--rm", "--network none", "--read-only", "--tmpfs /tmp:rw,size=2g", "--security-opt no-new-privileges", "--cap-drop all", "--userns keep-id", "--cpus 4", "--memory 8192m", "--memory-swap 8192m", "--pids-limit 1024"]) {
      assert.ok(s.includes(f), f);
    }
    assert.deepEqual(argv.slice(-3), ["registry.test/rust@sha256:aa", "cargo", "build"].slice(-3));
  });

  test("only the four allowed mounts, source read-only, no host env or privileges", () => {
    const m = argv.flatMap((a, i) => (argv[i - 1] === "--mount" ? [a] : []));
    assert.deepEqual(m, [
      "type=bind,source=/w/src,target=/src,readonly",
      "type=bind,source=/w/target,target=/target",
      "type=bind,source=/w/cache,target=/cache",
      "type=bind,source=/w/out,target=/out",
    ]);
    for (const bad of ["-v", "--volume", "--privileged", "--env-host", "--device", "--network=host", "--userns=host"]) assert.ok(!argv.includes(bad), bad);
    const env = argv.flatMap((a, i) => (argv[i - 1] === "--env" ? [a] : []));
    assert.deepEqual(env, ["HOME=/tmp", "CARGO_HOME=/cache/cargo", "CARGO_TARGET_DIR=/target", "CI=1"]);
  });

  test("fetch steps use the configured network", () => {
    const a = runArgs(cfg, { name: "n", image: "i", network: "fetch", mounts, cmd: [] });
    assert.equal(a[a.indexOf("--network") + 1], "pasta");
  });
});

describe("executor", () => {
  test("runs steps in order, offline except fetch, and cleans up", async () => {
    resetCalls();
    const cfg = mkCfg();
    const { s, logs } = sink();
    const r = await executeTask(cfg, mkTask(1, [step("fetch deps", ["echo:fetching"], { network: "fetch" }), step("build", ["echo:building"]), step("test", ["echo:ok"])]), s, live());
    assert.equal(r.summary, "3 steps passed");
    assert.deepEqual(r.results.map((x) => [x.step, x.exitCode, x.timedOut]), [["fetch deps", 0, false], ["build", 0, false], ["test", 0, false]]);
    const nets = runCalls().map((c) => c[c.indexOf("--network") + 1]);
    assert.deepEqual(nets, ["pasta", "none", "none"]);
    assert.match(logs.join(""), /building/);
    assert.deepEqual(readdirSync(cfg.workDir).filter((e) => e.startsWith("task-")), []);
    assert.ok(calls().some((c) => c[0] === "rm" && c[1] === "-f"));
  });

  test("a failing step stops the plan", async () => {
    resetCalls();
    const cfg = mkCfg();
    const r = await executeTask(cfg, mkTask(2, [step("build", ["exit:101"]), step("test", ["echo:no"])]), sink().s, live());
    assert.equal(r.results.length, 1);
    assert.equal(r.results[0]!.exitCode, 101);
    assert.match(r.summary, /build failed \(exit 101\)/);
    assert.equal(runCalls().length, 1);
  });

  test("timeout kills the container and marks timedOut", async () => {
    resetCalls();
    const cfg = mkCfg();
    const r = await executeTask(cfg, mkTask(3, [step("hang", ["sleep"], { timeoutSec: 1 })]), sink().s, live());
    assert.equal(r.results[0]!.timedOut, true);
    assert.equal(r.results[0]!.exitCode, null);
    assert.ok(calls().some((c) => c[0] === "kill" && /^craft-3-0-/.test(c[1]!)));
    assert.match(r.summary, /timed out/);
  });

  test("cancel kills the running container and returns cancelled", async () => {
    resetCalls();
    const cfg = mkCfg();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    const r = await executeTask(cfg, mkTask(4, [step("hang", ["sleep"]), step("after", ["echo:x"])]), sink().s, ac.signal);
    assert.equal(r.cancelled, true);
    assert.ok(calls().some((c) => c[0] === "kill"));
    assert.equal(runCalls().length, 1);
    assert.ok(!existsSync(join(cfg.workDir, "task-4")));
  });

  test("artifacts: globs, symlink escape, size and count caps", async () => {
    resetCalls();
    const cfg = mkCfg();
    const { s, arts, logs } = sink();
    const ops = ["write:shots/a.png:PNG", "write:r.json:{}", "write:other.bin:zz", "link:esc.txt:/etc/hostname", "big:huge.txt:52428801"];
    for (let i = 0; i < 105; i++) ops.push(`write:many/f${i}.txt:x`);
    const r = await executeTask(cfg, mkTask(5, [step("shot", ops, { artifacts: ["**/*.png", "r.json", "esc.txt", "huge.txt", "many/*.txt", "../*", "/etc/*"] })]), s, live());
    assert.equal(r.results[0]!.exitCode, 0);
    const names = arts.map((a) => a.name);
    assert.ok(names.includes("shots__a.png") && names.includes("r.json"));
    assert.ok(!names.includes("esc.txt") && !names.includes("huge.txt") && !names.includes("other.bin"));
    assert.equal(names.length, 2 + 98 - 0 - 0 + 0 === 100 ? 100 : names.length); // count cap
    assert.equal(arts.length, 100);
    assert.match(logs.join(""), /task limit reached/);
    assert.match(logs.join(""), /over 50 MB/);
  });

  test("workdir and containers are removed when the runtime cannot start", async () => {
    resetCalls();
    const cfg = mkCfg({ runtime: join(root, "no-such-runtime") });
    const r = await executeTask(cfg, mkTask(6, [step("build", ["echo:x"])]), sink().s, live());
    assert.match(r.summary, /container runtime failed/);
    assert.deepEqual(readdirSync(cfg.workDir).filter((e) => e.startsWith("task-")), []);
  });

  test("workdir is removed when the sink throws", async () => {
    const cfg = mkCfg();
    const bad: TaskSink = { log: async () => {}, artifact: async () => { throw new Error("upload down"); } };
    await assert.rejects(executeTask(cfg, mkTask(7, [step("shot", ["write:a.png:x"], { artifacts: ["*.png"] })]), bad, live()), /upload down/);
    assert.ok(!existsSync(join(cfg.workDir, "task-7")));
  });

  test("a bad tarball fails the task without running a container", async () => {
    resetCalls();
    coord.tarballs.set("/src/bad.tgz", makeTarGz([{ name: "p/../../x", data: "x" }]));
    const r = await executeTask(mkCfg(), mkTask(8, [step("build", ["echo:x"])], "/src/bad.tgz"), sink().s, live());
    assert.match(r.summary, /source failed/);
    assert.equal(runCalls().length, 0);
  });

  test("stale work dirs are removed at start", () => {
    const cfg = mkCfg();
    mkdirSync(join(cfg.workDir, "task-99/src"), { recursive: true });
    mkdirSync(join(cfg.workDir, "crate-cache"), { recursive: true });
    assert.equal(removeStaleWorkDirs(cfg), 1);
    assert.ok(existsSync(join(cfg.workDir, "crate-cache")));
  });
});

describe("crate cache", () => {
  const crate = (home: string, file: string, data = "c") => {
    const d = join(home, "registry/cache/index.crates.io-abc");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, file), data);
  };

  test("only .crate files go back to the shared cache; seeding copies, never links", () => {
    const shared = join(root, "shared");
    const task = join(root, "taskhome");
    crate(task, "serde-1.0.0.crate");
    crate(task, "evil.sh");
    mkdirSync(join(task, "registry/src/x"), { recursive: true });
    writeFileSync(join(task, "registry/src/x/lib.rs"), "planted");
    mkdirSync(join(task, "bin"), { recursive: true });
    writeFileSync(join(task, "bin/tool"), "planted");
    assert.equal(promoteCargoHome(task, shared), 1);
    assert.deepEqual(readdirSync(shared), ["registry"]);
    assert.deepEqual(readdirSync(join(shared, "registry/cache/index.crates.io-abc")), ["serde-1.0.0.crate"]);
    const next = join(root, "taskhome2");
    seedCargoHome(shared, next);
    assert.deepEqual(readdirSync(join(next, "registry")), ["cache"]);
    writeFileSync(join(next, "registry/cache/index.crates.io-abc/serde-1.0.0.crate"), "tampered");
    assert.equal(readFileSync(join(shared, "registry/cache/index.crates.io-abc/serde-1.0.0.crate"), "utf8"), "c");
  });
});

describe("rust plan and config", () => {
  test("rustPlan: network only for fetch, locked and offline elsewhere", () => {
    const p = rustPlan({ cargoArgs: ["--workspace"] });
    assert.deepEqual(p.map((s) => [s.name, s.network]), [["fetch deps", "fetch"], ["build", "none"], ["test", "none"]]);
    assert.deepEqual(p[0]!.cmd, ["cargo", "fetch", "--locked"]);
    for (const s of p.slice(1)) assert.ok(s.cmd.includes("--offline") && s.cmd.includes("--locked") && s.cmd.includes("--workspace"));
    assert.equal(rustPlan({ test: false }).length, 2);
  });

  test("config defaults and validation", () => {
    const c = parseWorkerConfig({ coordinatorUrl: "http://h:1/", keyFile: "/k", workDir: "/w" });
    assert.equal(c.coordinatorUrl, "http://h:1");
    assert.equal(c.runtime, "podman");
    assert.equal(c.limits.minFreeDiskGb, 20);
    assert.deepEqual(Object.keys(c.images).sort(), ["node-24", "rust-stable"]);
    assert.throws(() => parseWorkerConfig({ coordinatorUrl: "http://h", keyFile: "/k", workDir: "/w,x" }));
    assert.throws(() => parseWorkerConfig({ coordinatorUrl: "http://h", keyFile: "/k", workDir: "/w", images: { a: "--privileged" } }));
    assert.throws(() => parseWorkerConfig({ coordinatorUrl: "ftp://h", keyFile: "/k", workDir: "/w" }));
  });
});
