// CI parity of build tasks: gate input extraction, derived image tags, and the step environment.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseWorkerConfig, type WorkerConfig } from "../src/worker/config.ts";
import { runArgs } from "../src/worker/container.ts";
import { containerfile, derivedTag } from "../src/worker/environment.ts";
import { parseSandboxEnv } from "../src/build/tasks.ts";
import { executeTask, type TaskSink } from "../src/worker/executor.ts";
import { gateEnv, parseGateCall, parseGateDefaults, resolveGate } from "../src/worker/gate.ts";
import type { ClaimedTask } from "../src/worker/types.ts";
import { startFakeCoordinator, type FakeCoordinator } from "./fake-coordinator.ts";
import { makeTarGz } from "./tar-util.ts";
import { SCRATCH } from "./scratch.ts";

const FONTS = "b076417b5880bd4154bd22f00695b1d28c6bea83";
const DEFAULT_FONTS = "bfcbf714e45a3ea8e98f88ab2b7971372a576414";
const CI_YML = `name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  gate:
    # Tracks @main so suite-wide CI fixes reach every app.
    uses: storytold/craft-common-actions/.github/workflows/gate.yml@main
    with:
      # Same craft-fonts commit as release.yml.
      craft-fonts-ref: ${FONTS}
      timeout-minutes: 90
      packages: >-
        pkg-config libxkbcommon-dev libwayland-dev
        libxrandr-dev mesa-vulkan-drivers libxrandr-dev
      linux-env: |
        MY_FLAG=1
        PATH=/evil
        RUNNER=\${{ github.workspace }}
`;
const GATE_YML = `name: "Gate"
on:
  workflow_call:
    inputs:
      packages:
        description: "Ubuntu packages: separated by spaces"
        type: string
        required: true
      craft-fonts-ref:
        description: "The commit of storytold/craft-fonts"
        type: string
        required: false
        default: "${DEFAULT_FONTS}"
      require-craft-fonts:
        type: boolean
        required: false
        default: true
      dev-debug:
        type: string
        default: "line-tables-only"
      env:
        type: string
        default: ""
permissions:
  contents: read
jobs:
  gate:
    steps:
      - uses: actions/checkout@v7
        with:
          path: x
`;

describe("gate inputs", () => {
  test("reads the call and the gate defaults", () => {
    const call = parseGateCall(CI_YML)!;
    assert.equal(call.ref, "main");
    assert.equal(call.with["craft-fonts-ref"], FONTS);
    const d = parseGateDefaults(GATE_YML);
    assert.equal(d["craft-fonts-ref"], DEFAULT_FONTS);
    assert.equal(d["require-craft-fonts"], "true");
    assert.equal(d["dev-debug"], "line-tables-only");
    const g = gateEnv(call, d);
    assert.deepEqual(g.packages, ["libwayland-dev", "libxkbcommon-dev", "libxrandr-dev", "mesa-vulkan-drivers", "pkg-config"]);
    assert.equal(g.craftFontsRef, FONTS);
    assert.equal(g.requireFonts, true);
    assert.deepEqual(g.env, { CARGO_PROFILE_DEV_DEBUG: "line-tables-only", MY_FLAG: "1" });
    assert.deepEqual(g.dropped, ["PATH", "RUNNER"]);
  });

  test("an absent craft-fonts-ref takes the gate default; an empty one turns fonts off", () => {
    const d = parseGateDefaults(GATE_YML);
    assert.equal(gateEnv({ ref: "main", with: { packages: "a" } }, d).craftFontsRef, DEFAULT_FONTS);
    assert.equal(gateEnv({ ref: "main", with: { packages: "a", "craft-fonts-ref": "" } }, d).craftFontsRef, null);
  });

  test("a workflow without the gate, and bad package names", () => {
    assert.equal(parseGateCall("jobs:\n  build:\n    runs-on: ubuntu-latest\n"), null);
    assert.throws(() => gateEnv({ ref: "main", with: { packages: "ok $(touch x)" } }, {}), /package name/);
    assert.throws(() => gateEnv({ ref: "main", with: { packages: "ok", "craft-fonts-ref": "main" } }, {}), /commit id/);
  });

  test("resolveGate reads ci.yml at the given commit and gate.yml at the called ref", async () => {
    const urls: string[] = [];
    const f = (async (u: string) => {
      urls.push(u);
      const body = u.endsWith("/ci.yml") ? CI_YML : u.endsWith("/gate.yml") ? GATE_YML : null;
      return new Response(body, { status: body === null ? 404 : 200 });
    }) as unknown as typeof fetch;
    const sha = "c".repeat(40);
    const g = await resolveGate("designcraft", sha, f);
    assert.equal(g?.craftFontsRef, FONTS);
    assert.deepEqual(urls, [
      `https://raw.githubusercontent.com/storytold/designcraft/${sha}/.github/workflows/ci.yml`,
      "https://raw.githubusercontent.com/storytold/craft-common-actions/main/.github/workflows/gate.yml",
    ]);
    const none = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    assert.equal(await resolveGate("designcraft", sha, none), null);
    const down = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    await assert.rejects(resolveGate("designcraft", sha, down), /503/);
  });
});

describe("derived image", () => {
  const base = "docker.io/library/rust:1-bookworm@sha256:aa";
  test("the tag depends on the base reference and the package set, not on order", () => {
    const t = derivedTag("rust-stable", base, ["b", "a"]);
    assert.match(t, /^craft-sandbox\/rust-stable-[0-9a-f]{16}$/);
    assert.equal(t, derivedTag("rust-stable", base, ["a", "b"]));
    assert.notEqual(t, derivedTag("rust-stable", base, ["a"]));
    assert.notEqual(t, derivedTag("rust-stable", base.replace("aa", "bb"), ["a", "b"]));
  });
  test("the Containerfile installs the sorted list on the base", () => {
    const c = containerfile(base, ["b", "a"]);
    assert.match(c, new RegExp(`^FROM ${base.replaceAll(".", "\\.")}\n`));
    assert.match(c, /apt-get install -y --no-install-recommends a b && /);
  });
});

describe("step environment", () => {
  let coord: FakeCoordinator;
  let root: string;
  let rtDir: string;
  const FAKE = resolve(dirname(fileURLToPath(import.meta.url)), "fake-runtime.mjs");
  const calls = (): string[][] => readFileSync(join(rtDir, "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  before(async () => {
    mkdirSync(SCRATCH, { recursive: true });
    root = mkdtempSync(join(SCRATCH, "ci-parity-"));
    rtDir = join(root, "rt");
    mkdirSync(rtDir);
    process.env.FAKE_RT_DIR = rtDir;
    coord = await startFakeCoordinator();
    coord.tarballs.set("/src/t.tgz", makeTarGz([{ name: "r-aaa/" }, { name: "r-aaa/Cargo.lock", data: "x" }, { name: "r-aaa/craft-i18n.rev", data: `${"d".repeat(40)}\n` }]));
  });
  after(async () => {
    await coord.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("a gated repo gets the derived image, read-only checkouts and env; the record names them", async () => {
    const cfg: WorkerConfig = parseWorkerConfig({
      coordinatorUrl: "http://127.0.0.1:1", keyFile: "/nonexistent-key", workDir: join(root, "work"), runtime: FAKE,
      images: { "rust-stable": "registry.test/rust@sha256:aa" },
    });
    mkdirSync(cfg.workDir, { recursive: true });
    const fonts = makeTarGz([{ name: "f-1/" }, { name: "f-1/font.ttf", data: "ttf" }]);
    // The fake serves /src/* only; codeload and raw URLs are routed by the fetch wrapper.
    const fetchImpl = (async (u: string, init?: RequestInit) => {
      const url = String(u);
      if (url.endsWith("/ci.yml")) return new Response(CI_YML);
      if (url.endsWith("/gate.yml")) return new Response(GATE_YML);
      if (url.startsWith("https://codeload.github.com/storytold/craft-fonts/")) return new Response(new Uint8Array(fonts));
      if (url.startsWith("https://codeload.github.com/storytold/craft-i18n/")) return new Response(new Uint8Array(fonts));
      return fetch(url, init);
    }) as typeof fetch;
    const task: ClaimedTask = {
      id: 7, repo: "designcraft", headSha: "a".repeat(40), baseSha: "b".repeat(40), requires: { toolchains: ["rust-stable"] },
      plan: [{ name: "test", cmd: ["do", "echo:hi"], network: "none", timeoutSec: 30 }], sourceUrl: `${coord.url}/src/t.tgz`,
    };
    const logs: string[] = [];
    const sink: TaskSink = { log: async (_s, c) => void logs.push(c), artifact: async () => {} };
    const r = await executeTask(cfg, task, sink, new AbortController().signal, { fetchImpl });
    assert.equal(r.summary, "1 step passed", logs.join(""));
    const tag = derivedTag("rust-stable", "registry.test/rust@sha256:aa", ["libwayland-dev", "libxkbcommon-dev", "libxrandr-dev", "mesa-vulkan-drivers", "pkg-config"]);
    assert.deepEqual(r.environment, {
      image: tag, baseImage: "registry.test/rust@sha256:aa", packages: ["libwayland-dev", "libxkbcommon-dev", "libxrandr-dev", "mesa-vulkan-drivers", "pkg-config"],
      craftFontsRef: FONTS, craftI18nRev: "d".repeat(40),
    });
    assert.ok(existsSync(join(rtDir, `image-${tag.replaceAll("/", "_")}`)), "the image was built");
    const run = calls().find((c) => c[0] === "run")!;
    const joined = run.join(" ");
    assert.ok(run.includes(tag));
    assert.match(joined, /type=bind,source=\S+\/ext\/craft-fonts\/b076417b5880bd4154bd22f00695b1d28c6bea83,target=\/craft-fonts,readonly/);
    assert.match(joined, /target=\/craft-i18n,readonly/);
    for (const e of ["CRAFT_FONTS_DIR=/craft-fonts", "CRAFT_FONTS_REQUIRED=1", "CRAFT_I18N_DIR=/craft-i18n", "CRAFT_I18N_REQUIRED=1", "MY_FLAG=1", "CARGO_PROFILE_DEV_DEBUG=line-tables-only"]) assert.ok(run.includes(e), e);
    assert.ok(!run.includes("PATH=/evil"));
    assert.ok(logs.join("").includes("craft-fonts b076417b5880"));
  });

  test("runArgs puts the gate env before the worker's own, so it cannot override them", () => {
    const cfg = parseWorkerConfig({ coordinatorUrl: "http://127.0.0.1:1", keyFile: "/k", workDir: join(root, "w2") });
    const a = runArgs(cfg, { name: "n", image: "img", network: "none", mounts: { src: "/s", target: "/t", cache: "/c", out: "/o" }, cmd: ["x"], env: { A: "1" } });
    assert.ok(a.indexOf("A=1") < a.indexOf("HOME=/tmp"));
  });
});

describe("task record", () => {
  test("the reported environment is validated", () => {
    const ok = { image: "craft-sandbox/rust-stable-0123456789abcdef", baseImage: "docker.io/library/rust:1-bookworm", packages: ["pkg-config"], craftFontsRef: FONTS, craftI18nRev: null };
    assert.deepEqual(parseSandboxEnv(ok), ok);
    assert.equal(parseSandboxEnv(undefined), null);
    assert.throws(() => parseSandboxEnv({ ...ok, craftFontsRef: "main" }), /commit id/);
    assert.throws(() => parseSandboxEnv({ ...ok, packages: ["a b"] }), /packages/);
  });
});
