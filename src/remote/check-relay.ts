// The `check` tool of a remote call. The harness calls it on the dashboard, but the call's CheckTool lives in the job
// process that waits for the call (askRemote's awaitCall), which keeps its call count, time limit and `ran` set. The
// dashboard inserts a request row and polls for its result; the job's poll loop takes requested rows of its call and
// runs them on the CheckTool. Polling only: both sides use the model queue's poll interval.
import type { DatabaseSync } from "node:sqlite";
import { allocation } from "../agents/call.ts";
import type { CheckResult, CheckTool } from "../checktool/index.ts";

/** How often the waiting dashboard request calls `tick` (the HTTP layer writes a keep-alive byte). */
const TICK_MS = 15_000;

const over = (db: DatabaseSync, id: number, r: CheckResult, nowMs = Date.now()): void => {
  db.prepare("UPDATE main.remote_checks SET state = 'done', result = ?, ended_at = ? WHERE id = ? AND state != 'done'").run(JSON.stringify(r), nowMs, id);
};

/** Job side, on each poll of a leased call: starts the call's requested checks on `tool`, each recorded under the run the request names. */
export function serveChecks(db: DatabaseSync, callId: number, tool: Pick<CheckTool, "run">): void {
  const rows = db.prepare("SELECT id, run_id, input FROM main.remote_checks WHERE call_id = ? AND state = 'requested' ORDER BY id").all(callId) as { id: number; run_id: number | null; input: string }[];
  for (const r of rows) {
    if (Number(db.prepare("UPDATE main.remote_checks SET state = 'running' WHERE id = ? AND state = 'requested'").run(r.id).changes) !== 1) continue;
    let input: unknown;
    try { input = JSON.parse(r.input); } catch { input = null; }
    void tool.run(input, r.run_id).then(
      (res) => over(db, r.id, res),
      (e) => over(db, r.id, { text: `the check could not run: ${String((e as Error).message ?? e).slice(0, 200)}`, isError: true }),
    ).catch(() => { /* the database is closed: the process is ending */ });
  }
}

/** Job side, when the call has ended: requests nobody will run get an answer. */
export function endChecks(db: DatabaseSync, callId: number): void {
  db.prepare("UPDATE main.remote_checks SET state = 'done', result = ?, ended_at = ? WHERE call_id = ? AND state = 'requested'")
    .run(JSON.stringify({ text: "refused: the model call is over", isError: true }), Date.now(), callId);
}

/**
 * Dashboard side: queues one check for the call and waits for its result. `live` says whether the lease still holds (checked
 * on each poll; a request still waiting when it ends is withdrawn), `signal` is the client going away, `tick` is called about
 * every 15 s while waiting.
 */
export async function relayCheck(db: DatabaseSync, call: { id: number; runId: number | null }, input: unknown, opts: { live: () => boolean; signal?: AbortSignal; tick?: () => void }): Promise<CheckResult> {
  const id = Number(db.prepare("INSERT INTO main.remote_checks (call_id, run_id, input, state, requested_at) VALUES (?, ?, ?, 'requested', ?)")
    .run(call.id, call.runId, JSON.stringify(input ?? null), Date.now()).lastInsertRowid);
  let lastTick = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, allocation.pollMs));
    const r = db.prepare("SELECT state, result FROM main.remote_checks WHERE id = ?").get(id) as { state: string; result: string | null } | undefined;
    if (r?.state === "done" && r.result) return JSON.parse(r.result) as CheckResult;
    const gone = opts.signal?.aborted ? "the request was cancelled" : !opts.live() ? "the lease is gone" : null;
    if (gone || !r) {
      // A running check is left to finish on the job side; only a request nobody took is withdrawn.
      db.prepare("UPDATE main.remote_checks SET state = 'done', result = ?, ended_at = ? WHERE id = ? AND state = 'requested'").run(JSON.stringify({ text: `refused: ${gone}`, isError: true }), Date.now(), id);
      return { text: `the check did not run to the end: ${gone ?? "the request is gone"}`, isError: true };
    }
    if (opts.tick && Date.now() - lastTick >= TICK_MS) {
      lastTick = Date.now();
      opts.tick();
    }
  }
}
