// The model call queue as the dashboard shows it (GET /api/model-queue, src/dash/api/model-queue.ts): every queued call with
// a live caller in claim order, why it waits, and the ready Task Runners. Reads only; picks are in picks.ts.
import type { DatabaseSync } from "node:sqlite";
import type { ItemRef, ModelQueueWhyCode } from "../../web/src/api/types.ts";
import { WRITE_PERMISSIONS } from "../dash/server/provider.ts";
import { pickerLogins, pickCounts, queueSnapshot, roleFits } from "./calls.ts";
import { gating } from "./claim-class.ts";
import { cooloffOf } from "./cooloff.ts";
import { STATUS_FRESH_MS } from "./helpers.ts";
import { manualSql } from "./manual-only.ts";
import { userMaxCalls } from "./max-calls.ts";
import { acceptedModels, familyOf, isTier } from "./mode.ts";
import { claimRepos } from "./my-repos.ts";
import type { Tier } from "./protocol.ts";
import { CALLER_STALE_MS } from "./room.ts";

/** A fresh, ready Task Runner of a user who is not cooled off. `free`: slots without the fast lane its token does not use, within the user's Max calls at once. */
export type ReadyRunner = { login: string; role: string; manual: boolean; tiers: ReadonlySet<Tier>; free: number; repos: ReadonlySet<string> | null };

export function readyRunners(db: DatabaseSync, nowMs: number): ReadyRunner[] {
  const rows = db.prepare(`SELECT t.id, t.login, a.role, h.models, COALESCE(h.slots, 1) AS slots, ${manualSql("t.login")} AS manual,
      (SELECT COUNT(*) FROM main.remote_calls c WHERE c.state = 'leased' AND c.token_id = t.id) AS leased
    FROM main.mcp_tokens t JOIN main.remote_helpers h ON h.token_id = t.id JOIN main.access a ON a.login = t.login
    WHERE t.kind = 'runner' AND t.expires_at > ? AND h.readiness = 'ready' AND h.reported_at >= ?`).all(new Date(nowMs).toISOString(), nowMs - STATUS_FRESH_MS) as
    { id: number; login: string; role: string; models: string; slots: number; manual: number; leased: number }[];
  const accepted = acceptedModels(db);
  const userLeft = new Map<string, number>();
  const left = (login: string): number => {
    const key = login.toLowerCase();
    let n = userLeft.get(key);
    if (n === undefined) {
      const max = userMaxCalls(db, login);
      n = max === null ? Infinity : Math.max(0, max - Number((db.prepare("SELECT COUNT(*) AS n FROM main.remote_calls WHERE state = 'leased' AND user_login = ? COLLATE NOCASE").get(login) as { n: number }).n));
      userLeft.set(key, n);
    }
    return n;
  };
  const out: ReadyRunner[] = [];
  for (const r of rows) {
    if (cooloffOf(db, r.login, nowMs)) continue;
    let models: Record<string, unknown> = {};
    try { models = JSON.parse(r.models) as Record<string, unknown>; } catch { /* no models */ }
    const tiers = new Set<Tier>();
    for (const [t, m] of Object.entries(models)) if (isTier(t) && typeof m === "string" && familyOf(m, accepted[t]) !== null) tiers.add(t);
    const slots = Number(r.slots) - (Number(r.slots) >= 2 ? 1 : 0);
    out.push({ login: r.login, role: r.role, manual: Number(r.manual) === 1, tiers, free: Math.min(left(r.login), Math.max(0, slots - Number(r.leased))), repos: claimRepos(db, r.login, undefined) });
  }
  return out;
}

/** What whyWaiting reads of a queued call. `picked`: its live pick (login null when the viewer may not see it). */
export type WhyCall = { tier: Tier; promptId: string; repos: readonly string[]; followUp: boolean; picked: { login: string | null } | null };

/**
 * Why a queued call waits, most specific first: its pick; the runner that holds its session; no ready runner for its tier;
 * every such runner Manual only; no such runner's user may take it (role rules, write permission as last confirmed, My
 * repos); every runner that may take it busy; else the calls ahead of it.
 */
export function whyWaiting(c: WhyCall, runners: readonly ReadyRunner[], ahead: number, canWrite: (login: string, repo: string) => boolean): { code: ModelQueueWhyCode; text: string } {
  if (c.picked) return { code: "picked", text: c.picked.login ? `Picked by ${c.picked.login}` : "Picked by a user" };
  if (c.followUp) return { code: "session", text: "Waiting for the Task Runner that holds its session" };
  const forTier = runners.filter((r) => r.tiers.has(c.tier));
  if (!forTier.length) return { code: "no-runner", text: `No Task Runner is ready for the ${c.tier} tier` };
  const auto = forTier.filter((r) => !r.manual);
  if (!auto.length) return { code: "manual-only", text: "Every ready Task Runner is Manual only" };
  const may = auto.filter((r) => roleFits(r.role, { prompt_id: c.promptId, repos: [...c.repos] }) && c.repos.every((x) => canWrite(r.login, x) && (!r.repos || r.repos.has(x))));
  if (!may.length) return { code: "no-repo-access", text: c.repos.length ? "No ready Task Runner's user takes calls on its repo" : "No ready Task Runner's user may take it" };
  if (!may.some((r) => r.free > 0)) return { code: "busy", text: "Every Task Runner that may take it is busy" };
  return { code: "behind", text: ahead === 0 ? "Next in line" : `${ahead} call${ahead === 1 ? "" : "s"} ahead` };
}

/** A queued call of the view, before the role's redaction. `pickedBy`: the login of its live pick. */
export type QueuedCall = {
  id: number; step: string; promptId: string; tier: Tier; model: string; refs: ItemRef[]; repos: string[]; authors: ReadonlySet<string>;
  waitedMs: number; followUp: boolean; gating: boolean; pickedBy: string | null; pickUntil: number | null; seenAt: number; lastError: string | null;
  why: { code: ModelQueueWhyCode; text: string };
};

/** The queued calls with a live caller in claim order, why each waits (`showPicker`: name the picker), and the ready runners. */
export function queueView(db: DatabaseSync, nowMs: number, showPicker: boolean): { calls: QueuedCall[]; runners: ReadyRunner[] } {
  const snap = queueSnapshot(db, nowMs).filter((r) => r.seen_at >= nowMs - CALLER_STALE_MS);
  const runners = readyRunners(db, nowMs);
  if (!snap.length) return { calls: [], runners };
  const extra = new Map((db.prepare("SELECT id, asked_model, queued_ms, queued_since, error FROM main.remote_calls WHERE id IN (SELECT value FROM json_each(?))").all(JSON.stringify(snap.map((r) => r.id))) as
    { id: number; asked_model: string; queued_ms: number; queued_since: number | null; error: string | null }[]).map((r) => [Number(r.id), r]));
  const writable = new Set<string>();
  for (const p of db.prepare("SELECT login, repo, permission FROM main.repo_permissions WHERE login IN (SELECT value FROM json_each(?))").all(JSON.stringify(runners.map((r) => r.login))) as { login: string; repo: string; permission: string }[])
    if (WRITE_PERMISSIONS.has(p.permission)) writable.add(`${p.login.toLowerCase()}\n${p.repo}`);
  const fresh = pickerLogins(db, nowMs);
  const ahead = new Map<Tier, number>();
  const calls: QueuedCall[] = [];
  for (const r of snap) {
    const x = extra.get(r.id);
    if (!x) continue;
    const picked = pickCounts(r, nowMs, (l) => fresh.has(l)) ? r.pickedBy : null;
    const followUp = r.parent_id !== null;
    const n = ahead.get(r.tier) ?? 0;
    const why = whyWaiting({ tier: r.tier, promptId: r.prompt_id, repos: r.repos, followUp, picked: picked === null ? null : { login: showPicker ? picked : null } }, runners, n, (l, repo) => writable.has(`${l.toLowerCase()}\n${repo}`));
    if (!followUp && picked === null) ahead.set(r.tier, n + 1);
    calls.push({
      id: r.id, step: r.step, promptId: r.prompt_id, tier: r.tier, model: x.asked_model, refs: r.refs, repos: r.repos, authors: r.authors,
      waitedMs: Number(x.queued_ms) + (x.queued_since === null ? 0 : Math.max(0, nowMs - Number(x.queued_since))), followUp, gating: gating(r),
      pickedBy: picked, pickUntil: picked === null ? null : r.pickUntil, seenAt: r.seen_at, lastError: x.error, why,
    });
  }
  return { calls, runners };
}
