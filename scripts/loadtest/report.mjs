// The acceptance report: reads the rig's database, ledger, proxy log and dashboard log and checks the lines of section 4 of
// the robustness plan that apply to the scenario.
import { readFileSync } from "node:fs";
import { MIX, pct } from "./rig.mjs";

const ms = (v) => (v === null || v === undefined ? "n/a" : `${Math.round(v)} ms`);
const s = (v) => (v === null || v === undefined ? "n/a" : `${(v / 1000).toFixed(1)} s`);

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
  m.cooloffs = db.prepare("SELECT at, target, login FROM main.audit WHERE action = 'remote-cooloff' ORDER BY at").all().map((r) => ({ at: r.at, tokenId: Number(r.target), login: r.login }));
  m.cooloffHelpers = [...new Set(m.cooloffs.map((c) => rig.helpers.findIndex((h) => h && h.tokenId === c.tokenId) + 1))];
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
  if (num.includes("noDouble")) add("no call run twice after a requeue", m.answeredAgain.length === 0, `${m.answeredAgain.length} answered twice, ${m.duplicateRuns.length} started more than once`);
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
