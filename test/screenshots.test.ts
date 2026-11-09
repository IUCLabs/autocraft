// Screenshots, collect side: the switch gates every step, and only a clear regression on an unchanged head holds a merge.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { storeArtifact, tempPath } from "../src/build/artifacts.ts";
import { setFeature } from "../src/build/features.ts";
import { getTask } from "../src/build/tasks.ts";
import { connect } from "../src/db.ts";
import { parseCompareReply, parseScreenshotReply, type CompareParsed } from "../src/verify/plan.ts";
import { runCollect, collectDue, type CollectDeps } from "../src/verify/results.ts";
import { putConfig, type ScreenshotConfigBody } from "../src/verify/screenshot-config.ts";
import { runVerify, type VerifyDeps } from "../src/verify/index.ts";
import { SCRATCH } from "./scratch.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "shots-collect-"));
process.env.AUTOCRAFT_ARTIFACT_DIR = join(dir, "artifacts");
const T0 = "2026-01-01T00:00:00Z";
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const CFG: ScreenshotConfigBody = {
  package: "app-ui", example: "snapshot", driver: "args", ui_paths: ["crates/ui*/**"],
  commands: { snap: { doc: "Render the main window.", params: { size: { enum: ["1440x900"] } }, argv: ["--out", "{out}", "--size", "{size}"], capture: true } },
};
const UI_DIFF = "diff --git a/crates/ui/src/dialog.rs b/crates/ui/src/dialog.rs\n--- a/crates/ui/src/dialog.rs\n+++ b/crates/ui/src/dialog.rs\n@@ -1,1 +1,2 @@\n fn a() {}\n+fn b() {}\n";
const png = (tag: string): Buffer => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(tag)]);

let planCalls = 0, compareCalls = 0;
function fresh(): DatabaseSync {
  const db = connect(join(mkdtempSync(join(dir, "db-")), "t.db"));
  process.env.AUTOCRAFT_DIFF_CACHE = mkdtempSync(join(dir, "diffs-"));
  planCalls = 0; compareCalls = 0;
  db.prepare(`INSERT INTO items (repo, number, kind, state, title, author, additions, deletions, head_oid, created_at, updated_at)
    VALUES ('app', 7, 'pr', 'OPEN', 'Show size', 'someone', 5, 0, ?, '${T0}', '${T0}')`).run(HEAD);
  db.prepare(`INSERT INTO opus_reviews (repo, number, head_oid, run_id, at, model, verdict, reason, fixes, sure, mode) VALUES ('app', 7, ?, 'rv', '${T0}', 'm', 'take', 'ok', '[]', 1, 'full')`).run(HEAD);
  db.prepare(`INSERT INTO pr_checks (repo, number, head_oid, state, is_draft, overall, checks, mergeable, maintainer_can_modify, fetched_at)
    VALUES ('app', 7, ?, 'OPEN', 0, 'success', '[]', 'MERGEABLE', 1, '${T0}')`).run(HEAD);
  db.prepare("INSERT INTO tracked_repos (name, added_by, added_at, pipeline) VALUES ('app', 'op', ?, 1)").run(T0);
  db.prepare("INSERT INTO repos (name, visibility) VALUES ('app', 'public')").run();
  putConfig(db, "op", "app", CFG);
  return db;
}
const verifyDeps: VerifyDeps = {
  fetchDiff: async () => ({ ok: true, text: UI_DIFF }), fetchCrates: async () => ({ ok: true, rust: true, crates: [] }),
  baseOf: async () => BASE, mainHead: async () => null, model: "sonnet",
  screenshots: { plan: async () => { planCalls++; return parseScreenshotReply(JSON.stringify([{ ref: "app#7", screenshot: true, reason: "Dialog changes", steps: [{ cmd: "snap", args: { size: "1440x900" } }] }]), "app#7", CFG); } },
};
const count = (db: DatabaseSync, sql: string): number => db.prepare(sql).all().length;
const switchOn = (db: DatabaseSync): void => { setFeature(db, "screenshots", true, "op"); setFeature(db, "screenshots", true, "op", "app"); };

/** Plans a run, then ends both tasks as a worker would: results for every step, one screenshot each. */
async function rendered(db: DatabaseSync, shots: { head: string; base: string }, o: { headFails?: boolean } = {}): Promise<{ head: number; base: number }> {
  await runVerify(db, { repo: "app" }, () => {}, verifyDeps);
  const run = db.prepare("SELECT head_task_id AS h, base_task_id AS b FROM screenshot_runs").get() as { h: number; b: number };
  for (const [id, tag, fails] of [[run.h, shots.head, o.headFails === true], [run.b, shots.base, false]] as const) {
    const t = getTask(db, id)!;
    const results = t.plan.map((s, i) => ({ step: s.name, exitCode: fails && i === t.plan.length - 1 ? 1 : 0, timedOut: false, durationMs: 1 }));
    if (!fails) { const tmp = tempPath(id); writeFileSync(tmp, png(tag)); storeArtifact(db, id, "s1.png", tmp); }
    db.prepare("UPDATE build_tasks SET state = ?, results = ?, ended_at = ? WHERE id = ?").run(fails ? "failed" : "done", JSON.stringify(results), T0, id);
  }
  return { head: run.h, base: run.b };
}
const collect = (db: DatabaseSync, verdict: CompareParsed | (() => void)): Promise<unknown> => runCollect(db, {}, () => {}, {
  model: "haiku",
  screenshots: { compare: async (_i, { ref }) => { compareCalls++; if (typeof verdict === "function") { verdict(); return parseCompareReply(JSON.stringify([{ ref, verdict: "regression", clear: true, summary: "Broken." }]), ref); } return verdict; } },
} satisfies CollectDeps);
const reply = (v: string, clear: boolean): CompareParsed => parseCompareReply(JSON.stringify([{ ref: "app#7", verdict: v, clear, summary: "Handles moved outside the outline." }]), "app#7");

describe("screenshots switch off (test A)", () => {
  test("nothing is queued, recorded, planned or compared; an in-flight run is cancelled and skipped", async () => {
    const db = fresh();
    for (const on of [false, true]) {
      if (on) setFeature(db, "screenshots", true, "op");   // global only: the repo's own switch is still off
      await runVerify(db, { repo: "app" }, () => {}, verifyDeps);
      assert.deepEqual([count(db, "SELECT 1 FROM build_tasks"), count(db, "SELECT 1 FROM screenshot_runs"), planCalls], [0, 0, 0]);
      assert.deepEqual(db.prepare("SELECT kind, state FROM verifications").all().map((r) => ({ ...r })), [{ kind: "ci-enough", state: "ci-enough" }]);
      db.prepare("DELETE FROM verifications").run();
    }
    assert.equal(collectDue(db), false);
    const s = await runCollect(db, {}, () => {}, { model: "haiku" });
    assert.equal(s.shots, 0);

    switchOn(db);
    const t = await rendered(db, { head: "x", base: "y" });
    db.prepare("UPDATE build_tasks SET state = 'queued', ended_at = NULL WHERE id = ?").run(t.head);
    setFeature(db, "screenshots", false, "op");
    assert.equal(collectDue(db), true);
    await collect(db, reply("regression", true));
    assert.equal(compareCalls, 0);
    assert.deepEqual({ ...db.prepare("SELECT state, reason FROM screenshot_runs").get() }, { state: "skipped", reason: "screenshots switched off" });
    assert.equal(getTask(db, t.head)!.state, "cancelled");
    assert.equal(count(db, "SELECT 1 FROM merge_holds"), 0);
  });
});

describe("screenshots collect (test B)", () => {
  test("a clear regression holds the merge and leaves the verification alone", async () => {
    const db = fresh(); switchOn(db);
    await rendered(db, { head: "broken", base: "fine" });
    const before = db.prepare("SELECT * FROM verifications").all();
    await collect(db, reply("regression", true));
    assert.equal(compareCalls, 1);
    assert.deepEqual({ ...db.prepare("SELECT state, verdict, clear, held FROM screenshot_runs").get() }, { state: "compared", verdict: "regression", clear: 1, held: 1 });
    assert.equal(count(db, "SELECT 1 FROM merge_holds WHERE repo = 'app' AND number = 7"), 1);
    assert.equal(count(db, "SELECT 1 FROM stages WHERE stage = 'screenshot-regression'"), 1);
    assert.deepEqual(db.prepare("SELECT * FROM verifications").all(), before);
  });

  test("no hold when the regression is not clear, the head task failed, or the head moved during the comparison; identical images make no model call", async () => {
    let db = fresh(); switchOn(db);
    await rendered(db, { head: "broken", base: "fine" });
    await collect(db, reply("regression", false));
    assert.equal(count(db, "SELECT 1 FROM merge_holds"), 0);
    assert.equal(db.prepare("SELECT verdict FROM screenshot_runs").get()!.verdict, "regression");

    db = fresh(); switchOn(db);
    await rendered(db, { head: "x", base: "fine" }, { headFails: true });
    await collect(db, reply("regression", true));
    assert.equal(compareCalls, 0);
    assert.equal(db.prepare("SELECT state FROM screenshot_runs").get()!.state, "error");
    assert.equal(count(db, "SELECT 1 FROM merge_holds"), 0);

    db = fresh(); switchOn(db);
    await rendered(db, { head: "broken", base: "fine" });
    await collect(db, () => { db.prepare("UPDATE items SET head_oid = ? WHERE repo = 'app'").run("c".repeat(40)); db.prepare("UPDATE pr_checks SET head_oid = ? WHERE repo = 'app'").run("c".repeat(40)); });
    assert.deepEqual({ ...db.prepare("SELECT state, held FROM screenshot_runs").get() }, { state: "compared", held: 0 });
    assert.equal(count(db, "SELECT 1 FROM merge_holds"), 0);

    db = fresh(); switchOn(db);
    await rendered(db, { head: "same", base: "same" });
    await collect(db, reply("regression", true));
    assert.equal(compareCalls, 0);
    assert.equal(db.prepare("SELECT verdict FROM screenshot_runs").get()!.verdict, "unchanged");
    assert.equal(count(db, "SELECT 1 FROM merge_holds"), 0);
  });
});
