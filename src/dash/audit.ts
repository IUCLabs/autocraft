import type { DatabaseSync } from "node:sqlite";

export function audit(db: DatabaseSync, login: string, action: string, target: string | null, details?: unknown): void {
  db.prepare("INSERT INTO audit (at, login, action, target, details) VALUES (?, ?, ?, ?, ?)")
    .run(new Date().toISOString(), login, action, target, details === undefined ? null : JSON.stringify(details));
}
