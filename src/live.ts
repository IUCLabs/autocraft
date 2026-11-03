// Change markers: one counter per topic in `change_seq`, bumped by triggers on the
// tables the dashboard reads. Triggers fire for writes from every process (runner,
// sync, sandbox worker, dashboard), so no code path can forget to signal.
import type { DatabaseSync } from "node:sqlite";

type Source = { table: string; ops?: ("INSERT" | "UPDATE" | "DELETE")[]; when?: string };

/** topic -> the tables whose changes it reports. */
export const TOPIC_TABLES: Record<string, Source[]> = {
  repos: [{ table: "repos" }, { table: "tracked_repos" }, { table: "sync_runs" }],
  items: [
    { table: "items" }, { table: "comments" }, { table: "stages" }, { table: "item_stage" }, { table: "pr_checks" }, { table: "classifications" },
    { table: "item_priority" }, { table: "item_rank" }, { table: "duplicate_pairs" }, { table: "duplicate_scans" }, { table: "patch_checks" },
    { table: "whitelist_overrides" }, { table: "flow_summary" },
  ],
  decisions: [{ table: "decisions" }, { table: "decision_opinions" }, { table: "decision_comments" }, { table: "decision_claims" }],
  reviews: [{ table: "reviews" }, { table: "opus_reviews" }, { table: "review_posts" }],
  queue: [{ table: "merges" }, { table: "merge_batches" }, { table: "merge_batch_prs" }],
  jobs: [{ table: "jobs" }, { table: "stage_limits" }],
  usage: [{ table: "token_usage" }, { table: "account_usage_samples" }],
  accounts: [{ table: "claude_accounts" }, { table: "claude_account_status" }],
  agents: [{ table: "agent_runs" }, { table: "agent_run_items" }, { table: "agent_run_texts" }],
  // Every worker poll writes last_seen_at; only changes to what an environment is or reports matter.
  envs: [{ table: "build_envs", ops: ["INSERT", "DELETE"] }, { table: "build_envs", ops: ["UPDATE"], when: "old.label IS NOT new.label OR old.kind IS NOT new.kind OR old.enabled IS NOT new.enabled OR old.slots IS NOT new.slots OR old.key_hash IS NOT new.key_hash OR old.capabilities IS NOT new.capabilities OR old.reported_slots IS NOT new.reported_slots OR old.version IS NOT new.version OR old.paused_reason IS NOT new.paused_reason" }],
  tasks: [{ table: "build_tasks" }, { table: "build_task_logs" }, { table: "build_artifacts" }],
  actions: [{ table: "actions" }],
  fixes: [{ table: "fix_attempts" }],
  verify: [{ table: "verifications" }, { table: "fixups" }],
  // Sessions change on every request (last_seen); only sign-ins and revocations matter.
  access: [{ table: "access" }, { table: "sessions", ops: ["INSERT", "DELETE"] }, { table: "audit" }],
  // The runner writes its heartbeat here every tick; the pipeline page ages it on a slow timer.
  settings: [{ table: "settings", when: "new_key <> 'runner_heartbeat'" }],
};

export const TOPICS = Object.keys(TOPIC_TABLES);

const ALL_OPS = ["INSERT", "UPDATE", "DELETE"] as const;

/** DDL for the marker table, its rows and the triggers. Idempotent: triggers are rebuilt. */
export function liveSql(): string {
  const out = [
    "CREATE TABLE IF NOT EXISTS main.change_seq (topic TEXT PRIMARY KEY, seq INTEGER NOT NULL, at TEXT) WITHOUT ROWID;",
    ...TOPICS.map((t) => `INSERT OR IGNORE INTO main.change_seq (topic, seq, at) VALUES ('${t}', 0, NULL);`),
  ];
  for (const [topic, sources] of Object.entries(TOPIC_TABLES)) {
    for (const { table, ops = ALL_OPS, when } of sources) {
      for (const op of ops) {
        const name = `live_${table}_${op[0]!.toLowerCase()}`;
        const key = op === "DELETE" ? "old.key" : "new.key";
        const cond = when ? `WHEN ${when.replaceAll("new_key", key)}` : "";
        // Unqualified change_seq: a trigger body may not name a schema.
        out.push(`DROP TRIGGER IF EXISTS main.${name};`);
        out.push(`CREATE TRIGGER main.${name} AFTER ${op} ON ${table} ${cond} BEGIN
          UPDATE change_seq SET seq = seq + 1 WHERE topic = '${topic}';
        END;`);
      }
    }
  }
  return out.join("\n");
}

/** The current counter of every topic. */
export function readSeqs(db: DatabaseSync): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of db.prepare("SELECT topic, seq FROM change_seq").all() as { topic: string; seq: number }[]) out[r.topic] = r.seq;
  return out;
}
