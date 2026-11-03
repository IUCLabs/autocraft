// A deploy never restarts a sandbox worker that has tasks: the update is recorded, the
// environment drains, and the runner applies it once the tasks are done.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { createEnv, hello } from "../src/build/envs.ts";
import { claim, createTask } from "../src/build/tasks.ts";
import { checkPendingUpdate, MAX_FAILURES, pendingUpdate, requestUpdate, statusLines, updateFailures, type UpdateSpec, type WorkerAdmin } from "../src/build/worker-update.ts";
import { connect } from "../src/db.ts";
import { SCRATCH } from "./scratch.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "worker-drain-"));
const db = connect(join(dir, "drain.db"));
const SHA = "a".repeat(40);
const NEW = "b".repeat(40);
const NEWER = "c".repeat(40);
const CAPS = { os: "linux", arch: "x86_64", cpus: 8, memGb: 32, diskGb: 200, display: false, gpu: false, toolchains: ["rust-stable"] };
const PLAN = [{ name: "t", cmd: ["true"], network: "none" as const, timeoutSec: 10 }];
const spec = (sha: string): UpdateSpec => ({ sha, ssh: "worker@example.invalid", keyFile: "/nonexistent/key", gitDir: "/nonexistent/repo.git" });

/** A fake admin command: records calls, reports `running` as the worker's version. */
function fake(opts: { running?: string; fail?: boolean } = {}) {
  const calls: string[] = [];
  const admin: WorkerAdmin = {
    async version() { calls.push("version"); return opts.running ?? SHA; },
    async update(s) { calls.push(`update ${s.sha}`); if (opts.fail) throw new Error("ssh: connection refused"); },
  };
  return { admin, calls };
}

let n = 0;
function env() {
  const id = `env-${++n}`;
  createEnv(db, { id, label: id, kind: "local-sandbox", slots: 2 }, "op");
  hello(db, id, { version: "1.0", capabilities: CAPS, slots: 8 });
  return id;
}
const queue = () => createTask(db, { step: "verify", repo: "open-app", headSha: SHA, plan: PLAN });
const reset = () => db.exec("DELETE FROM build_tasks; DELETE FROM settings WHERE key LIKE 'worker_update%'");

before(() => {
  db.exec("INSERT INTO tracked_repos (name, pipeline) VALUES ('open-app', 1)");
  db.exec("INSERT INTO repos (name, visibility) VALUES ('open-app', 'public')");
});
after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("worker update while tasks run", () => {
  test("with a running task, update-code records the update and does not touch the worker", async () => {
    reset();
    const e = env();
    queue();
    assert.equal(claim(db, e, 1).tasks.length, 1);
    const r = await requestUpdate(db, spec(NEW), fake({ running: SHA }).admin);
    assert.deepEqual(r, { result: "waiting", busy: 1 });
    assert.equal(pendingUpdate(db)?.sha, NEW);
    const g = fake({ running: SHA });
    await requestUpdate(db, spec(NEWER), g.admin);
    assert.equal(pendingUpdate(db)?.sha, NEWER);   // a newer deploy replaces the pending one
    assert.ok(!g.calls.some((c) => c.startsWith("update")));
  });

  test("claim hands an environment nothing while an update is pending", async () => {
    reset();
    const busy = env(), idle = env();
    queue();
    claim(db, busy, 1);
    await requestUpdate(db, spec(NEW), fake({ running: SHA }).admin);
    assert.ok(pendingUpdate(db));
    const t = queue();
    assert.deepEqual(claim(db, idle, 5).tasks, []);
    assert.equal((db.prepare("SELECT state FROM build_tasks WHERE id = ?").get(t) as { state: string }).state, "queued");
  });

  test("the runner's check updates once the task finishes and clears the key", async () => {
    reset();
    const e = env();
    const t = queue();
    claim(db, e, 1);
    await requestUpdate(db, spec(NEW), fake({ running: SHA }).admin);
    const f = fake({ running: SHA });
    assert.equal(await checkPendingUpdate(db, f.admin), false);   // still running
    assert.deepEqual(f.calls, []);
    db.prepare("UPDATE build_tasks SET state = 'passed', ended_at = ? WHERE id = ?").run(new Date().toISOString(), t);
    assert.equal(await checkPendingUpdate(db, f.admin), true);
    assert.ok((f.calls as string[]).includes(`update ${NEW}`));
    assert.equal(pendingUpdate(db), null);
    const t2 = queue();
    assert.deepEqual(claim(db, e, 1).tasks.map((x: { id: number }) => x.id), [t2]);   // claiming works again
  });

  test("with no tasks, update-code updates immediately; the same sha does nothing", async () => {
    reset();
    env();
    const f = fake({ running: SHA });
    assert.deepEqual(await requestUpdate(db, spec(NEW), f.admin), { result: "updated", busy: 0 });
    assert.deepEqual(f.calls, ["version", `update ${NEW}`]);
    assert.equal(pendingUpdate(db), null);
    const same = fake({ running: NEW });
    assert.equal((await requestUpdate(db, spec(NEW), same.admin)).result, "current");
    assert.deepEqual(same.calls, ["version"]);
  });

  test("a failing update stays pending, is counted, and stops retrying after MAX_FAILURES", async () => {
    reset();
    env();
    db.prepare("INSERT INTO settings (key, value) VALUES ('worker_update_pending', ?)").run(JSON.stringify(spec(NEW)));
    const f = fake({ running: SHA, fail: true });
    const logs: string[] = [];
    for (let i = 0; i < MAX_FAILURES + 2; i++) assert.equal(await checkPendingUpdate(db, f.admin, (m) => logs.push(m)), false);
    assert.equal(pendingUpdate(db)?.sha, NEW);
    assert.equal(updateFailures(db)?.count, MAX_FAILURES);
    assert.equal(f.calls.filter((c) => c.startsWith("update")).length, MAX_FAILURES);
    assert.match(statusLines(db).join("\n"), /pending[\s\S]*connection refused/);
    // a newer deploy while busy resets the count; here it is idle, so it updates and clears
    assert.equal((await requestUpdate(db, spec(NEWER), fake({ running: SHA }).admin)).result, "updated");
    assert.equal(updateFailures(db), null);
  });
});
