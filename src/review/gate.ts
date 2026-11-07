// Reasons a due review waits: another item blocks the PR, CI at its head has not passed, or the PR used its reviews for the day.
import type { DatabaseSync } from "node:sqlite";
import { audit } from "../dash/audit.ts";
import { effectiveCi } from "../optional-checks.ts";
import { openBlockers, storedBlockedBy } from "./blockers.ts";
import { MAX_RERUNS_PER_DAY, reviewRequestedSince } from "./discussion.ts";

/** Opus reviews of one PR per UTC day, new heads and re-runs together. */
export const MAX_REVIEWS_PER_DAY = MAX_RERUNS_PER_DAY;

/** Setting: least minutes between two Opus reviews of one PR; 0 turns the wait off. */
export const MIN_INTERVAL_KEY = "review_min_interval_minutes";
export const MIN_INTERVAL_DEFAULT = 120;
const MIN_INTERVAL_MAX = 7 * 24 * 60;

export function reviewMinInterval(db: DatabaseSync): number {
  const v = (db.prepare("SELECT value FROM main.settings WHERE key = ?").get(MIN_INTERVAL_KEY) as { value: string } | undefined)?.value;
  const n = Number(v);
  return v !== undefined && Number.isInteger(n) && n >= 0 && n <= MIN_INTERVAL_MAX ? n : MIN_INTERVAL_DEFAULT;
}

export function setReviewMinInterval(db: DatabaseSync, input: unknown, by: string): number {
  const n = typeof input === "number" ? input : typeof input === "string" && /^[0-9]+$/.test(input) ? Number(input) : NaN;
  if (!Number.isInteger(n) || n < 0 || n > MIN_INTERVAL_MAX) throw new Error(`the minimum minutes between reviews must be a whole number from 0 to ${MIN_INTERVAL_MAX}`);
  const was = reviewMinInterval(db);
  db.prepare("INSERT INTO main.settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(MIN_INTERVAL_KEY, String(n));
  if (n !== was) audit(db, by, "review-min-interval", "pipeline", { minutes: n, was });
  return n;
}

/** `until`: when an interval wait ends (ms), so the planner wakes then. */
export type ReviewHold = { kind: "blocked" | "ci" | "cap" | "interval"; wait: string; until?: number };

/** CI at the PR's head as the review gate reads it: "ok" (passed, or no checks and none pending), "pending", "failure", or "unknown" when the stored checks describe another head. */
export function headCi(db: DatabaseSync, repo: string, number: number, head: string): "ok" | "pending" | "failure" | "unknown" {
  const c = db.prepare("SELECT head_oid, overall, checks FROM main.pr_checks WHERE repo = ? AND number = ?").get(repo, number) as { head_oid: string; overall: string; checks: string | null } | undefined;
  if (!c || c.head_oid !== head) return "unknown";
  const o = effectiveCi(db, repo, c.overall, c.checks);
  return o === "pending" ? "pending" : o === "failure" ? "failure" : "ok";
}

/**
 * What holds back the next review of a PR at `head`, or null. A maintainer's or operator's request after the latest review lifts every hold.
 * An unknown CI state does not hold (the review step reads the checks live before asking the model and applies this again).
 */
export function reviewHold(db: DatabaseSync, repo: string, number: number, head: string, nowMs: number = Date.now()): ReviewHold | null {
  const last = db.prepare(`SELECT head_oid, at, verdict, seen_at, disc_hash, blocked_by FROM main.opus_reviews WHERE repo = ? AND number = ? AND verdict IS NOT NULL ORDER BY at DESC, rowid DESC LIMIT 1`)
    .get(repo, number) as { head_oid: string; at: string; verdict: string; seen_at: string | null; disc_hash: string | null; blocked_by: string | null } | undefined;
  if (last && reviewRequestedSince(db, repo, number, last.at, last.seen_at, last.disc_hash)) return null;
  if (last?.verdict === "hold") {
    const open = openBlockers(db, storedBlockedBy(last.blocked_by));
    if (open.length) return { kind: "blocked", wait: `${open.join(", ")}, which blocks its review` };
  }
  const ci = headCi(db, repo, number, head);
  if (ci === "pending") return { kind: "ci", wait: "CI on the latest commit to finish" };
  if (ci === "failure") return { kind: "ci", wait: "CI on the latest commit to pass" };
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const n = (db.prepare("SELECT COUNT(*) AS n FROM main.opus_review_history WHERE repo = ? AND number = ? AND model IS NOT NULL AND at >= ?").get(repo, number, today) as { n: number }).n;
  if (n >= MAX_REVIEWS_PER_DAY) return { kind: "cap", wait: "review cap for today reached; next on a maintainer's request or tomorrow" };
  const gap = reviewMinInterval(db) * 60_000;
  if (gap) {
    const at = (db.prepare("SELECT MAX(at) AS at FROM main.opus_review_history WHERE repo = ? AND number = ? AND model IS NOT NULL").get(repo, number) as { at: string | null }).at;
    const until = at ? Date.parse(at) + gap : 0;
    if (until > nowMs) return { kind: "interval", wait: `next review after ${new Date(until).toISOString().slice(11, 16)}`, until };
  }
  return null;
}
