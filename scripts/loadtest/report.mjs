// The acceptance report: reads the rig's database, ledger, proxy log and dashboard log and checks the lines of section 4 of
// the robustness plan that apply to the scenario.
import { readFileSync } from "node:fs";
import { MIX, pct } from "./rig.mjs";

const ms = (v) => (v === null || v === undefined ? "n/a" : `${Math.round(v)} ms`);
const s = (v) => (v === null || v === undefined ? "n/a" : `${(v / 1000).toFixed(1)} s`);

const OUTCOMES = ["submitted", "lost", "failed", "rejected", "released"];

/**
 * How each lease a helper ran ended, from its log: `lease <id>[ (fast lane)]: <title>`, then `<outcome>: <title>, …` or
 * `<outcome>: <title>: …`. A lease id is its call's id. Returns call id -> outcomes, one per lease of the call.
 */
export function leaseOutcomes(rig) {
  /** @type {Map<number, string[]>} */
  const out = new Map();
  for (const h of rig.helpers) {
    if (!h) continue;
    let text = "";
    try { text = readFileSync(h.log, "utf8"); } catch { continue; }
    /** @type {{ id: number, title: string }[]} */
    const open = [];
    for (const line of text.split("\n")) {
      const l = /^lease (\d+)(?: \(fast lane\))?: (.+)$/.exec(line);
      if (l) { open.push({ id: Number(l[1]), title: l[2] }); continue; }
      const state = OUTCOMES.find((o) => line.startsWith(`${o}: `));
      if (!state) continue;
      const rest = line.slice(state.length + 2);
      const i = open.findIndex((x) => rest === x.title || rest.startsWith(`${x.title},`) || rest.startsWith(`${x.title}:`));
      if (i < 0) continue;
      const [x] = open.splice(i, 1);
      out.set(x.id, [...(out.get(x.id) ?? []), state]);
    }
  }
  return out;
}

export function collect(rig) {
  const db = rig.db;
  const rows = new Map(db.prepare("SELECT id, state, tier, prompt_id, queued_ms, attempt, error, token_id, user_login FROM main.remote_calls").all().map((r) => [Number(r.id), r]));
  const m = { calls: rig.calls.size, done: 0, failed: 0, open: 0, lost: [], answeredAgain: [], duplicateRuns: [], failedByHarness: 0 };
  const waits = { top: [], mid: [], small: [], gating: [], followUp: [] };
  for (const [nonce, c] of rig.calls) {
    const r = rows.get(c.id);
    const l = rig.ledger.get(nonce) ?? [];
    const starts = l.filter((e) => e.ev === "start").length, answered = l.filter((e) => e.ev === "answered").length;
    if (!r) { m.open++; continue; }
    if (r.state === "done") { m.done++; waits[c.tier].push(Number(r.queued_ms)); if (c.gating) waits.gating.push(Number(r.queued_ms)); if (c.followUp) waits.followUp.push(Number(r.queued_ms)); }
    else if (r.state === "failed") { m.failed++; if (/fail/i.test(r.error ?? "") ) m.failedByHarness++; }
    else m.open++;
    if (answered > 0 && r.state !== "done") m.lost.push({ call: c.id, prompt: c.promptId, state: r.state, error: r.error });
    if (answered > 1) m.answeredAgain.push({ call: c.id, answered });
    if (starts > 1) m.duplicateRuns.push({ call: c.id, starts });
  }
  m.waits = waits;
  // A call that ran again after a requeue (a frozen or lost helper) is expected; its earlier lease's reply must be refused.
  const outcomes = leaseOutcomes(rig);
  m.acceptedTwice = [...outcomes].filter(([, o]) => o.filter((x) => x === "submitted").length > 1).map(([call, o]) => ({ call, outcomes: o }));
  m.rerunOutcomes = m.duplicateRuns.map((d) => ({ call: d.call, outcomes: outcomes.get(d.call) ?? [] }));
  // The cool-off is per login: the audit target is the login cooled off.
  m.cooloffs = db.prepare("SELECT at, target FROM main.audit WHERE action = 'remote-cooloff' ORDER BY at").all().map((r) => ({ at: r.at, login: String(r.target) }));
  m.cooloffHelpers = [...new Set(m.cooloffs.flatMap((c) => rig.helpers.flatMap((h, i) => (h && h.login.toLowerCase() === c.login.toLowerCase() ? [i + 1] : []))))];
  m.requeues = db.prepare("SELECT COUNT(*) AS n FROM main.remote_calls WHERE attempt > 1").get().n;
  const reqs = readFileSync(rig.proxyLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const clean = reqs.filter((r) => r.upMs !== undefined && r.status > 0 && !/-after$|^upstream/.test(r.fault) && r.fault !== "reset-after");
  const up = clean.map((r) => r.upMs);
  m.proxy = { requests: reqs.length, faults: {}, upstream: { n: up.length, p50: pct(up, 50), p99: pct(up, 99), max: up.length ? Math.max(...up) : null, over5s: up.filter((x) => x > 5000).length }, byRoute: {}, dashboard5xx: reqs.filter((r) => r.status >= 500 && !r.fault).length };
  for (const r of reqs) if (r.fault) m.proxy.faults[r.fault] = (m.proxy.faults[r.fault] ?? 0) + 1;
  for (const r of clean) { const k = r.route; (m.proxy.byRoute[k] ??= []).push(r.upMs); }
  for (const [k, v] of Object.entries(m.proxy.byRoute)) m.proxy.byRoute[k] = { n: v.length, p50: pct(v, 50), p99: pct(v, 99), max: Math.max(...v) };
  const dlog = readFileSync(`${rig.dir}/dashboard.log`, "utf8");
  m.busyErrors = (dlog.match(/SQLITE_BUSY|database is (locked|busy)/gi) ?? []).length;
  m.dashErrorLines = (dlog.match(/^.*(error|uncaught).*$/gim) ?? []).slice(0, 5);
  m.idleNoReason = [...new Set(rig.samples.flatMap((x) => x.idleNoReason))];
  return m;
}

/** @returns {{ lines: string[], checks: { ok: boolean, name: string, detail: string }[] }} */
export function evaluate(rig, spec, m) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ ok, name, detail });
  const num = spec.accept ?? [];
  if (num.includes("noLoss")) add("no finished reply lost", m.lost.length === 0, `${m.lost.length} lost${m.lost.length ? `: ${m.lost.slice(0, 5).map((l) => `#${l.call} ${l.state}`).join(", ")}` : ""}`);
  if (num.includes("noCooloff")) add("no cool-off", m.cooloffs.length === 0, `${m.cooloffs.length} cool-off(s)${m.cooloffs.length ? ` (helpers ${m.cooloffHelpers.join(", ")})` : ""}`);
  if (num.includes("oneCooloff")) {
    const bad = rig.helpers.findIndex((h) => h?.failing) + 1;
    add("only the failing helper is cooled off", m.cooloffHelpers.length === 1 && m.cooloffHelpers[0] === bad, `cooled helpers: ${m.cooloffHelpers.join(", ") || "none"} (failing: ${bad})`);
    add("other helpers keep working", m.done > 0 && m.failed === 0, `${m.done} done, ${m.failed} failed for good`);
  }
  if (num.includes("noDouble")) add("no reply accepted from a requeued lease", m.acceptedTwice.length === 0, `${m.duplicateRuns.length} call(s) ran again after a requeue${m.rerunOutcomes.length ? ` (leases ended ${m.rerunOutcomes.map((r) => `#${r.call} ${r.outcomes.join("/") || "?"}`).join(", ")})` : ""}; ${m.acceptedTwice.length} accepted twice`);
  if (num.includes("latency")) {
    const u = m.proxy.upstream;
    add("dashboard p99 under 200 ms", u.p99 !== null && u.p99 < 200, `p50 ${ms(u.p50)}, p99 ${ms(u.p99)}, max ${ms(u.max)} over ${u.n} requests`);
    add("no request over 5 s", u.over5s === 0, `${u.over5s} over 5 s`);
    add("no SQLite busy errors", m.busyErrors === 0, `${m.busyErrors} in the dashboard log`);
    const g = m.waits.gating, gp = pct(g, 95);
    const lim = Math.max(5000, rig.sc(60_000));
    add(`gating calls wait under ${s(lim)} at p95`, gp !== null && gp < lim, `p95 ${s(gp)} over ${g.length} calls (lint checks and follow-ups)`);
  }
  if (num.includes("idle")) add("every idle helper shows a reason", m.idleNoReason.length === 0, m.idleNoReason.length ? `helpers idle without a reason: ${m.idleNoReason.join(", ")}` : "none idle without a reason");
  add("every call finished", m.open === 0 && m.failed === 0 || num.includes("oneCooloff"), `${m.done} done, ${m.failed} failed, ${m.open} still open of ${m.calls}`);
  const lines = [];
  lines.push(`== ${spec.name}: ${spec.title} (time scale ${rig.ts}; durations are real seconds, a production second is ${rig.ts} s here)`);
  lines.push(`calls ${m.calls}: ${m.done} done, ${m.failed} failed, ${m.open} open; requeued (attempt > 1): ${m.requeues}; started more than once: ${m.duplicateRuns.length}; answered more than once: ${m.answeredAgain.length}`);
  lines.push(`cool-offs: ${m.cooloffs.length}${m.cooloffs.length ? ` (helpers ${m.cooloffHelpers.join(", ")})` : ""}; lost replies: ${m.lost.length}`);
  const u = m.proxy.upstream;
  lines.push(`dashboard latency from the proxy (requests the dashboard answered, injected delay excluded): n ${u.n}, p50 ${ms(u.p50)}, p99 ${ms(u.p99)}, max ${ms(u.max)}, over 5 s ${u.over5s}; dashboard 5xx ${m.proxy.dashboard5xx}; SQLite busy lines ${m.busyErrors}`);
  lines.push(`injected faults: ${Object.entries(m.proxy.faults).map(([k, v]) => `${k} ${v}`).join(", ") || "none"} of ${m.proxy.requests} requests`);
  const routes = Object.entries(m.proxy.byRoute).sort((a, b) => b[1].p99 - a[1].p99).slice(0, 4).map(([r, v]) => `${r} p99 ${ms(v.p99)} max ${ms(v.max)} n ${v.n}`);
  if (routes.length) lines.push(`slowest routes: ${routes.join("; ")}`);
  lines.push(`queue wait p95 (time in the queue, rig clock): ${["top", "mid", "small"].map((t) => `${t} ${s(pct(m.waits[t], 95))} (n ${m.waits[t].length})`).join(", ")}; gating ${s(pct(m.waits.gating, 95))} (n ${m.waits.gating.length}); follow-ups ${s(pct(m.waits.followUp, 95))} (n ${m.waits.followUp.length})`);
  lines.push(`idle helpers without a reason: ${m.idleNoReason.length ? m.idleNoReason.join(", ") : "none"}`);
  if (m.dashErrorLines.length) lines.push(`dashboard log errors: ${m.dashErrorLines.map((x) => x.slice(0, 140)).join(" | ")}`);
  for (const c of checks) lines.push(`${c.ok ? "PASS" : "FAIL"}  ${c.name}: ${c.detail}`);
  return { lines, checks };
}

/**
 * Scenario 7's lines: how fast a held claim picks up a queued call, how often idle runners claim compared with polling every
 * 15 s, and how the claims held when the dashboard stopped were answered. `lp` is what the runners recorded (run.mjs).
 */
export function evaluateLongPoll(rig, spec, lp) {
  const checks = [], lines = [];
  const add = (name, ok, detail) => checks.push({ ok, name, detail });
  // Calls queued while the dashboard was down, or before the runners' first retry after it came back, wait for the restart.
  const settle = rig.sc(5000);
  const pickups = [], restartPickups = [];
  for (const c of rig.calls.values()) {
    const at = lp.leases.get(c.id);
    if (at === undefined) continue;
    (c.enqueuedAt >= lp.stopAt && c.enqueuedAt <= lp.backAt + settle ? restartPickups : pickups).push(at - c.enqueuedAt);
  }
  const lim = rig.sc(2000), p95 = pct(pickups, 95);
  add(`pickup p95 under ${s(lim)}`, p95 !== null && p95 < lim, `p50 ${ms(pct(pickups, 50))}, p95 ${ms(p95)}, max ${ms(pickups.length ? Math.max(...pickups) : null)} over ${pickups.length} calls; ${restartPickups.length} queued around the restart, max ${ms(restartPickups.length ? Math.max(...restartPickups) : null)}`);
  // Empty replies per production minute against polling's: every runner slot claims every 15 s when nothing is queued.
  const empties = lp.claims.filter((c) => c.status === 200 && c.lease === null && c.reason === null).length;
  const prodMin = (lp.end - lp.t0) / rig.ts / 60_000;
  const rate = empties / prodMin, baseline = spec.users * 4;
  add("idle claims below the polling rate", rate < baseline, `${rate.toFixed(1)} empty claims per production minute (${empties} in ${prodMin.toFixed(1)} min); polling every 15 s: ${baseline}`);
  const held = lp.claims.filter((c) => lp.stopAt && c.start < lp.stopAt && c.end >= lp.stopAt);
  const bad = held.filter((c) => c.status !== 200 || c.lease !== null);
  add("held claims answered at the restart, none reset", held.length > 0 && bad.length === 0, `${held.length} claims held when the dashboard stopped; ${bad.length} not answered with an empty reply${bad.length ? ` (statuses ${[...new Set(bad.map((c) => c.status))].join(", ")})` : ""}`);
  lines.push(`long polling: ${lp.claims.length} claims, ${lp.leases.size} leases, ${empties} empty`);
  for (const c of checks) lines.push(`${c.ok ? "PASS" : "FAIL"}  ${c.name}: ${c.detail}`);
  return { lines, checks, metrics: { pickups, restartPickups, empties, prodMin, held: held.length, bad: bad.length } };
}
