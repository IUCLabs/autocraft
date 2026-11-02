import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { connect } from "../src/db.ts";
import { routes } from "../src/dash/pages/index.ts";
import { funnelByRepo } from "../src/dash/pages/stats.ts";
import type { Req } from "../src/dash/types.ts";
import { selectSyncRepos } from "../src/mirror.ts";
import { purgeRepo, RepoError, scopeToTracked, trackedNames, trackRepo, untrackRepo } from "../src/repos.ts";

const SCRATCH = join(homedir(), ".cache/craft-automation-scratch");
mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "repos-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));

describe("tracked repos", () => {
  test("the seed runs once and does not return after the list is emptied", () => {
    const path = join(dir, "seed.db");
    const db = connect(path);
    assert.equal(trackedNames(db).length, 26);
    assert.ok(trackedNames(db).includes("photocraft"));
    db.exec("DELETE FROM tracked_repos");
    db.close();
    const again = connect(path);
    assert.deepEqual(trackedNames(again), []);
    again.close();
  });

  test("sync selects tracked repos by default, any repo with --repo, all with --all", () => {
    const listed = ["a", "b", "c"];
    assert.deepEqual(selectSyncRepos(listed, ["a", "c", "gone"], { only: [], all: false }), ["a", "c"]);
    assert.deepEqual(selectSyncRepos(listed, ["a"], { only: ["b"], all: false }), ["b"]);
    assert.deepEqual(selectSyncRepos(listed, ["a"], { only: [], all: true }), listed);
    assert.throws(() => selectSyncRepos(listed, [], { only: ["zzz"], all: false }), /unknown or archived/);
  });

  test("an untracked repo is hidden from pages and counts but its rows stay; purge needs it untracked", async () => {
    const db = connect(join(dir, "scope.db"));
    const ins = db.prepare(`INSERT INTO items (repo, number, kind, state, title, author, created_at, updated_at) VALUES (?, ?, 'pr', 'OPEN', 't', 'x', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`);
    for (const r of ["photocraft", "hidden-repo"]) {
      db.prepare("INSERT INTO repos (name, open_prs, open_issues) VALUES (?, 1, 0)").run(r);
      ins.run(r, 1);
    }
    db.prepare("INSERT INTO decisions (id, kind, repo, number, question, options, asked_at) VALUES ('d1', 'scope', 'hidden-repo', 1, 'q', '[]', 'now')").run();
    assert.equal(funnelByRepo(db).length, 2);
    scopeToTracked(db);
    assert.deepEqual(funnelByRepo(db).map((r) => r.repo), ["photocraft"]);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n, 1);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM decisions").get() as { n: number }).n, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM main.items").get() as { n: number }).n, 2);

    const rq = (path: string, params: Record<string, string>): Req => ({
      method: "GET", path, params, query: new URLSearchParams(), form: new URLSearchParams(),
      user: { login: "a", role: "admin", canWrite: async () => true }, csrf: "c", nonce: "n",
    });
    const get = async (pattern: string, path: string, params: Record<string, string>) =>
      routes.find((r) => r.method === "GET" && r.pattern === pattern)!.handler(db, rq(path, params));
    assert.equal(((await get("/item/:repo/:n", "/item/hidden-repo/1", { repo: "hidden-repo", n: "1" })) as { status: number }).status, 404);
    assert.equal(((await get("/repo/:name", "/repo/hidden-repo", { name: "hidden-repo" })) as { status: number }).status, 404);
    assert.equal(((await get("/item/:repo/:n", "/item/photocraft/1", { repo: "photocraft", n: "1" })) as { status?: number }).status ?? 200, 200);

    assert.throws(() => purgeRepo(db, "photocraft"), RepoError);
    assert.equal(untrackRepo(db, "t", "photocraft"), true);
    assert.deepEqual(purgeRepo(db, "photocraft"), { items: 1, comments: 0 });
    db.close();
  });

  test("track and untrack write audit rows", () => {
    const db = connect(join(dir, "audit.db"));
    assert.equal(trackRepo(db, "boss", "new-repo"), true);
    assert.equal(trackRepo(db, "boss", "new-repo"), false);
    assert.equal(untrackRepo(db, "cli", "new-repo"), true);
    const rows = db.prepare("SELECT login, action, target FROM audit ORDER BY rowid").all();
    assert.deepEqual(rows.map((r) => ({ ...r })), [
      { login: "boss", action: "repo-track", target: "new-repo" },
      { login: "cli", action: "repo-untrack", target: "new-repo" },
    ]);
    assert.throws(() => trackRepo(db, "boss", "bad name"), RepoError);
    db.close();
  });
});
