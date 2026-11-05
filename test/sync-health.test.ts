import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { connect } from "../src/db.ts";
import { computeChecks, serveChecks } from "../src/health-checks.ts";
import { GithubError, runSync } from "../src/mirror.ts";
import { SCRATCH } from "./scratch.ts";

function scratchDb() {
  const db = connect(join(mkdtempSync(join(SCRATCH, "synchealth-")), "m.db"));
  db.exec("DELETE FROM tracked_repos");
  db.exec("INSERT INTO tracked_repos (name, added_by, added_at) VALUES ('a','t','x'),('b','t','x')");
  return db;
}

test("a repo that no longer resolves is skipped and recorded; the sync run goes on", async () => {
  const db = scratchDb();
  db.exec("INSERT INTO repos (name, synced_at, high_water, reconciled_at) VALUES ('a','2026-11-02T09:00:00Z','2026-11-02T09:00:00Z','2026-11-01T00:00:00Z'),('b','2026-11-02T09:00:00Z','2026-11-02T09:00:00Z','2026-11-02T00:00:00Z')");
  db.exec("INSERT INTO settings VALUES ('org_high_water','2026-11-02T09:30:00Z'),('repos_refreshed_at','2999-01-01T00:00:00Z'),('search_catchup_at','2999-01-01T00:00:00Z')");
  const client = {
    spent: 0, remaining: 4000 as number | null,
    repoMovedTo: (owner: string, name: string) => `elsewhere/${name}-${owner.length}`,
    async query(query: string) {
      if (query.includes("search(")) return { search: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } };
      throw new GithubError('graphql error: [{"type":"NOT_FOUND","message":"Could not resolve to a Repository"}]', 0, "NOT_FOUND");
    },
  };
  const r = await runSync(db, client, { only: [], all: false, full: false, perRepo: false }, new Date("2026-11-02T10:05:00Z"));
  assert.equal(r.mode, "search");
  const err = db.prepare("SELECT repo, kind, moved_to FROM sync_repo_errors").all();
  assert.deepEqual(err.map((e) => ({ ...e })), [{ repo: "a", kind: "not-found", moved_to: "elsewhere/a-9" }]);
  // The failing repo gives up its place at the front of the daily reconcile, so repo b is next.
  assert.equal((db.prepare("SELECT reconciled_at AS t FROM repos WHERE name = 'a'").get() as { t: string }).t, "2026-11-02T10:05:00Z");
  const check = computeChecks(db, Date.parse("2026-11-02T10:06:00Z")).find((c) => c.id === "sync-repo:a");
  assert.equal(check?.state, "warn");
  assert.match(check!.text, /storytold\/a no longer resolves on GitHub \(moved to elsewhere\/a-9\)/);
});

test("GET /healthz/checks answers 503 with a stale worker and shows no repo names", async () => {
  const db = scratchDb();
  const now = Date.parse("2026-11-05T12:00:00Z");
  const at = (msAgo: number) => new Date(now - msAgo).toISOString();
  db.prepare("INSERT INTO settings (key, value) VALUES ('runner_heartbeat', ?)").run(at(5_000));
  db.prepare("INSERT INTO sync_runs (started_at, ended_at, mode, items) VALUES (?, ?, 'search', 0)").run(at(70_000), at(60_000));
  db.prepare("INSERT INTO build_envs (id, label, kind, enabled, slots, key_hash, last_seen_at, created_at) VALUES ('sandbox','Sandbox','local-sandbox',1,2,'h',?,?)").run(at(6 * 60_000), at(86_400_000));
  db.prepare("INSERT INTO sync_repo_errors (repo, kind, message, since, at) VALUES ('a','not-found','x',?,?)").run(at(1000), at(1000));
  const server = createServer((req, res) => { if (!serveChecks(req, res, db, now)) res.writeHead(404).end(); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/healthz/checks`;
  try {
    const bad = await fetch(url);
    assert.equal(bad.status, 503);
    const body = await bad.json() as { status: string; checks: { id: string; state: string; count?: number }[] };
    assert.equal(body.checks.find((c) => c.id === "worker:sandbox")?.state, "fail");
    assert.equal(body.checks.find((c) => c.id === "sync-repos")?.count, 1);
    assert.ok(!JSON.stringify(body).includes("storytold/a"));
    db.prepare("UPDATE build_envs SET last_seen_at = ?").run(at(10_000));
    assert.equal((await fetch(url)).status, 200);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
