#!/usr/bin/env node
// Runs the robustness scenarios (section 4 of the plan) against a scratch instance and prints the acceptance report.
//   node scripts/loadtest/run.mjs <smoke|1|2|3|4|5|6|7|all> [--dir <work dir>] [--db <db to copy>] [--time-factor F] [--time-scale S]
//                                 [--users N] [--parallel K] [--calls M] [--max-minutes N] [--sequential]
// `all` runs 1 to 5 side by side, then 6 and 7 each alone at their own scale. See README.md.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collect, evaluate, evaluateLongPoll } from "./report.mjs";
import { MIX, Rig, sleep } from "./rig.mjs";

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const flag = (n) => argv.includes(`--${n}`);
const which = argv.find((a) => !a.startsWith("--") && !argv[argv.indexOf(a) - 1]?.startsWith("--")) ?? "smoke";

// Every user-local time window (leases, heartbeats, cool-offs) and every scenario timing is multiplied by the scale
// (AUTOCRAFT_REMOTE_TIME_SCALE, test only); 1 runs the production windows. A scenario may name its own default scale; the
// driver's server modules read the scale once per process, so `all` runs such a scenario in a process of its own.
const SCALE_GIVEN = argv.includes("--time-scale");
const TIME_SCALE = Number(opt("time-scale", 0.1));
if (!(TIME_SCALE >= 0.01 && TIME_SCALE <= 1)) { console.error("--time-scale must be a number from 0.01 to 1"); process.exit(64); }
const S = (ms) => Math.max(1, Math.round(ms * TIME_SCALE));

const FAULTS = { rate502: 0.10, rateReset: 0.05, rate429: 0.02, retryAfter: 2, latMin: 0, latMax: 3000 };

/** Each scenario: defaults for the rig, what to do while the queue drains, and which acceptance lines apply. */
const SCENARIOS = {
  smoke: { title: "2 helpers, 20 calls, faults on", users: 2, parallel: 2, calls: 20, timeFactor: 0.05, faults: FAULTS, accept: ["noLoss", "idle"], maxMin: 8 },
  1: { title: "10% 502, 5% resets, 2% 429, 0-3 s latency", users: 6, parallel: 2, calls: 60, timeFactor: 0.1, faults: FAULTS, accept: ["noLoss", "idle"], maxMin: 12 },
  2: { title: "dashboard restarted mid-call, then stopped for 5 minutes", users: 6, parallel: 2, calls: 50, timeFactor: 0.5, accept: ["noLoss", "noCooloff", "idle"], maxMin: 16,
    async during(rig) { await sleep(S(60_000)); await rig.restartDashboard(); await sleep(S(60_000)); await rig.dashboardOutage(300 * TIME_SCALE); } },
  3: { title: "a helper frozen with SIGSTOP for 3 minutes", users: 4, parallel: 2, calls: 40, timeFactor: 0.5, accept: ["noLoss", "noDouble", "idle"], maxMin: 12,
    async during(rig) { await sleep(S(40_000)); rig.helpers[0].frozen = true; await rig.freezeHelper(0, 180 * TIME_SCALE); rig.helpers[0].frozen = false; } },
  4: { title: "a helper killed with SIGKILL mid-call and restarted", users: 4, parallel: 2, calls: 40, timeFactor: 0.5, accept: ["noLoss", "idle"], maxMin: 12,
    async during(rig) { await sleep(S(45_000)); rig.killHelper(0); await sleep(S(20_000)); rig.restartHelper(0); } },
  // The failing helper runs 5 slots and the fast lane, so its first claims fail 5 calls in a row (the cool-off threshold)
  // before the others drain the queue; one slot each would back off after every failure and see too few calls.
  5: { title: "a helper whose harness always fails", users: 5, parallel: 2, calls: 60, timeFactor: 0.1, failing: [4], failingParallel: 5, accept: ["oneCooloff", "idle"], maxMin: 10 },
  // Claims, heartbeats and status reports come at the scaled intervals, so the scale sets the dashboard's idle load: 0.5 is
  // about twice production's. The harness delays are cut instead (time factor) to keep the run short, and the calls arrive
  // over 25 s, as jobs queue them, rather than in one burst.
  6: { title: "50 helpers x 4 slots against 300 mixed calls", users: 50, parallel: 4, calls: 300, rampS: 25, timeFactor: 0.1, timeScale: 0.5, accept: ["noLoss", "latency", "idle"], maxMin: 25 },
  // Long-polling claims with protocol 4 claimers in this process (no harness: a lease is submitted at once), so the runners
  // sit in held claims nearly all the time. Production-scale times: calls over 120 s, the restart at 60 s.
  7: { title: "20 idle runners long-polling, random enqueues, a dashboard restart", users: 20, parallel: 1, calls: 60, spreadS: 120, restartAtS: 60, timeFactor: 1, timeScale: 0.25, longPoll: true, maxMin: 8 },
};

/** The time scale scenario `key` runs at: --time-scale when given, else the scenario's own, else the default. */
const scaleOf = (key) => (SCALE_GIVEN ? TIME_SCALE : SCENARIOS[key].timeScale ?? TIME_SCALE);

async function run(key) {
  const sp = SCENARIOS[key];
  if (sp.longPoll) return runLongPoll(key);
  const scale = scaleOf(key);
  const spec = { ...sp, name: `scenario-${key}`, users: Number(opt("users", sp.users)), parallel: Number(opt("parallel", sp.parallel)), calls: Number(opt("calls", sp.calls)), timeFactor: Number(opt("time-factor", sp.timeFactor)) * scale, maxMin: Number(opt("max-minutes", sp.maxMin * Math.max(scale, 0.3))) };
  const dir = opt("dir", join(tmpdir(), `autocraft-loadtest-${Date.now()}`));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const rig = new Rig({ name: spec.name, dir, users: spec.users, parallel: spec.parallel, timeFactor: spec.timeFactor, timeScale: scale, dbFrom: opt("db"), faults: sp.faults });
  try {
    await rig.init();
    for (let i = 0; i < spec.users; i++) {
      const failing = (sp.failing ?? []).includes(i);
      rig.startHelper(i, { failing, ...(failing && sp.failingParallel && { parallel: sp.failingParallel }) });
    }
    rig.note(`${spec.users} helpers started, ${spec.parallel} slots each`);
    await sleep(Math.min(S(20_000) + 3000, 4000 + spec.users * 300));
    await rig.enqueueMix(spec.calls, { rampMs: (sp.rampS ?? 0) * 1000 });
    rig.note(`${spec.calls} calls queued${sp.rampS ? ` over ${sp.rampS} s` : ""} (harness delay factor ${spec.timeFactor}, time scale ${scale})`);
    const during = sp.during ? sp.during(rig).catch((e) => rig.note(`scenario step failed: ${e.message}`)) : Promise.resolve();
    const drained = await rig.waitDrained(spec.maxMin * 60_000);
    await during;
    if (sp.failing) await sleep(S(5000));
    rig.note(drained ? "queue drained" : `not drained after ${spec.maxMin} min: ${rig.openCalls()} calls still open`);
    await rig.collectDone();
    rig.sample();
    const m = collect(rig);
    const { lines, checks } = evaluate(rig, spec, m);
    writeFileSync(join(rig.dir, "report.json"), JSON.stringify({ spec: { name: spec.name, title: spec.title }, metrics: m, checks, timeline: rig.events }, null, 1));
    return { key, lines, checks, dir: rig.dir };
  } finally {
    await rig.stop();
  }
}

/**
 * One long-polling runner slot: claims with `wait: 25` until `lp.stop`, submits each lease at once, and records every claim
 * (start, end, HTTP status, lease, reason) in `lp.claims` and each lease's time in `lp.leases`.
 */
async function longPollRunner(rig, u, lp) {
  const base = `http://127.0.0.1:${rig.proxyPort}`;
  const tiers = { top: "claude-opus-4-5", mid: "claude-sonnet-4-5", small: "claude-haiku-4-5" };
  const post = (path, bearer, body) => fetch(`${base}${path}`, { method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: lp.abort.signal });
  for (let n = 1; !lp.stop; n++) {
    const start = Date.now();
    let status = 0, reply = null;
    try {
      const r = await post("/api/remote/claim", u.token, { requestId: `${u.login}-${n}-${Math.random().toString(36).slice(2, 8)}`, protocol: 4, wait: 25, helperVersion: "1.2.0", harness: "claude", harnessVersion: "2.1.0", tiers });
      status = r.status;
      reply = status === 200 ? await r.json() : (await r.arrayBuffer(), null);
    } catch { /* reset or aborted */ }
    if (lp.stop) break;
    const end = Date.now();
    lp.claims.push({ start, end, status, lease: reply?.lease?.id ?? null, reason: reply?.reason ?? null });
    if (reply?.lease) {
      lp.leases.set(reply.lease.id, end);
      const tier = rig.db.prepare("SELECT tier FROM main.remote_calls WHERE id = ?").get(reply.lease.id)?.tier ?? "small";
      try { await (await post("/api/remote/submit", reply.lease.secret, { ok: true, text: "ok", model: tiers[tier], usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 1 })).arrayBuffer(); } catch { /* the job emulator requeues a lost lease */ }
      continue;
    }
    await sleep(status === 200 ? reply.retryAfter * 1000 : rig.sc(1000));
  }
}

async function runLongPoll(key) {
  const sp = SCENARIOS[key];
  const scale = scaleOf(key);
  const Sc = (ms) => Math.max(1, Math.round(ms * scale));
  const spec = { ...sp, name: `scenario-${key}`, users: Number(opt("users", sp.users)), calls: Number(opt("calls", sp.calls)) };
  const dir = opt("dir", join(tmpdir(), `autocraft-loadtest-${Date.now()}`));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const rig = new Rig({ name: spec.name, dir, users: spec.users, parallel: 1, timeFactor: 1, timeScale: scale, dbFrom: opt("db") });
  const lp = { claims: [], leases: new Map(), stop: false, abort: new AbortController(), t0: 0, end: 0, stopAt: 0, backAt: 0 };
  try {
    await rig.init();
    lp.t0 = Date.now();
    const runners = rig.users.map((u) => longPollRunner(rig, u, lp));
    rig.note(`${spec.users} long-polling runners started`);
    await sleep(Sc(5000));
    const during = (async () => {
      await sleep(Sc(sp.restartAtS * 1000));
      lp.stopAt = Date.now();
      await rig.restartDashboard();
      lp.backAt = Date.now();
    })().catch((e) => rig.note(`scenario step failed: ${e.message}`));
    // Random arrivals: exponential gaps around the mean, small and gating calls as jobs queue them between larger ones.
    const mean = Sc(sp.spreadS * 1000) / spec.calls;
    for (let i = 0; i < spec.calls; i++) {
      await sleep(-Math.log(1 - Math.random()) * mean);
      await rig.enqueue(MIX[i % MIX.length]);
      if (i === 0) rig.startJobEmulator();
    }
    rig.note(`${spec.calls} calls queued over about ${sp.spreadS} production seconds (time scale ${scale})`);
    await during;
    const drained = await rig.waitDrained(Number(opt("max-minutes", sp.maxMin)) * 60_000);
    rig.note(drained ? "queue drained" : `not drained: ${rig.openCalls()} calls still open`);
    // One more hold, so the runners' empty replies at their deadlines are counted.
    await sleep(Sc(30_000));
    lp.end = Date.now();
    lp.stop = true;
    lp.abort.abort();
    await Promise.all(runners);
    const m = collect(rig);
    const { lines, checks } = evaluate(rig, spec, m);
    const lpOut = evaluateLongPoll(rig, spec, lp);
    lines.push(...lpOut.lines);
    checks.push(...lpOut.checks);
    writeFileSync(join(rig.dir, "report.json"), JSON.stringify({ spec: { name: spec.name, title: spec.title }, metrics: { ...m, longPoll: lpOut.metrics }, checks, timeline: rig.events }, null, 1));
    return { key, lines, checks, dir: rig.dir };
  } finally {
    lp.stop = true;
    lp.abort.abort();
    await rig.stop();
  }
}

/** Runs scenario `key` in a child process (its own time scale) and returns its result. */
async function runApart(key) {
  const out = join(opt("dir", tmpdir()), `result-${key}-${process.pid}.json`);
  const args = argv.filter((a, i) => a !== which || argv[i - 1]?.startsWith("--"));
  const code = await new Promise((r) => spawn(process.execPath, [process.argv[1], key, ...args, "--result", out], { stdio: ["ignore", "inherit", "inherit"] }).on("close", r));
  try { return JSON.parse(readFileSync(out, "utf8")); } catch { return { key, lines: [`== scenario-${key}: the run ended without a result (exit ${code})`], checks: [{ ok: false, name: "the scenario ran", detail: `exit ${code}` }], dir: "" }; }
}

const started = Date.now();
const keys = which === "all" ? ["1", "2", "3", "4", "5", "6", "7"] : [which];
if (!keys.every((k) => SCENARIOS[k])) { console.error(`unknown scenario ${which}; use smoke, 1-7 or all`); process.exit(64); }
const results = [];
// Scenarios at another scale than the rest run apart; the rest share this process.
const apart = which === "all" ? keys.filter((k) => scaleOf(k) !== TIME_SCALE) : [];
const here = keys.filter((k) => !apart.includes(k));
if (which === "all" && !flag("sequential")) results.push(...await Promise.all(here.filter((k) => k !== "6" && k !== "7").map((k) => run(k))), ...(here.includes("6") ? [await run("6")] : []), ...(here.includes("7") ? [await run("7")] : []));
else for (const k of here) results.push(await run(k));
for (const k of apart) results.push(await runApart(k));
results.sort((a, b) => a.key.localeCompare(b.key));
if (opt("result")) { writeFileSync(opt("result"), JSON.stringify(results[0])); process.exit(0); }
console.log("\n==================== acceptance ====================");
for (const r of results) console.log(`${r.lines.join("\n")}\n(files: ${r.dir})\n`);
const fails = results.flatMap((r) => r.checks.filter((c) => !c.ok).map((c) => `scenario ${r.key}: ${c.name}`));
console.log(fails.length ? `FAILED ${fails.length}:\n  ${fails.join("\n  ")}` : "ALL PASSED");
console.log(`run time ${Math.round((Date.now() - started) / 1000)} s`);
process.exit(fails.length ? 1 : 0);
