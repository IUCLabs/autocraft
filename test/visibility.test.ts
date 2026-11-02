// A tracked repo that is not public is visible to operators and to users whose
// own GitHub permission on it is not "none"; to nobody else.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { AgentRunDetail, AgentRunPage, DecisionList, Flow, ItemList, Progress, QueueList, SearchHit } from "../web/src/api/types.ts";
import { addLogin } from "../src/access.ts";
import { insertRun, finishRun } from "../src/agents/runs.ts";
import { connect } from "../src/db.ts";
import { ask } from "../src/decisions.ts";
import { scopeToTracked } from "../src/repos.ts";
import { apiRoutes } from "../src/dash/api/index.ts";
import { loadConfig } from "../src/dash/server/config.ts";
import { startServer } from "../src/dash/server/index.ts";
import { FakeProvider } from "../src/dash/server/provider.ts";

const SCRATCH = join(homedir(), ".cache/craft-automation-scratch");
mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "visibility-test-"));
const dbFile = join(dir, "dash.db");
const permsFile = join(dir, "perms.json");
// reader has read on the internal repo; outsider has none.
writeFileSync(permsFile, JSON.stringify({ reader: { vault: "read" } }));

const db = connect(dbFile);
let base = "";
let close: () => Promise<void>;
const OPTS = [{ key: "a", label: "A" }, { key: "b", label: "B" }];

before(async () => {
  const now = new Date().toISOString();
  db.exec("DELETE FROM tracked_repos; INSERT INTO tracked_repos (name) VALUES ('open-app'), ('vault')");
  db.exec("INSERT INTO repos (name, visibility) VALUES ('open-app', 'public'), ('vault', 'internal')");
  const item = db.prepare("INSERT INTO items (repo, number, kind, state, title, body, head_oid, author, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)");
  const review = db.prepare("INSERT INTO reviews (repo, number, head_oid, run_id, at, size, verdict, reason) VALUES (?, ?, ?, 'r', ?, 'S', 'take', 'ok')");
  for (const repo of ["open-app", "vault"]) {
    item.run(repo, 1, "pr", "OPEN", `Wave filter in ${repo}`, "body", `h-${repo}`, "alice", now, now);
    review.run(repo, 1, `h-${repo}`, now);
  }
  ask(db, ["open-app", "vault"].map((repo) => ({
    id: `${repo}#1:scope`, kind: "scope", repo, number: 1, question: "A or B?", options: OPTS, recommended: "a", summary: "s",
  })));
  ask(db, [{ id: "batch", kind: "scope", repo: null, number: null, items: [{ repo: "open-app", number: 1 }, { repo: "vault", number: 1 }], question: "Batch?", options: OPTS, recommended: "a", summary: "s" }] as never);
  for (const repo of ["open-app", "vault"]) {
    const id = insertRun(db, { jobId: null, step: "classify", stage: 1, promptId: "p", promptVersion: "1", provider: "claude", model: "m", accountId: null, items: [{ repo, number: 1 }], prompt: `prompt for ${repo}` });
    finishRun(db, id, { state: "done", output: `output for ${repo}` });
  }
  addLogin(db, "cli", "boss", "operator", null);
  addLogin(db, "cli", "reader", "viewer", null);
  addLogin(db, "cli", "outsider", "viewer", null);
  scopeToTracked(db);
  const config = loadConfig({ CRAFT_AUTO_DEV_AUTH: "1", CRAFT_AUTO_LISTEN: "127.0.0.1:0", CRAFT_AUTO_DB: dbFile, CRAFT_AUTO_DEV_PERMS: permsFile });
  const s = await startServer({ config, db, provider: new FakeProvider(permsFile), routes: apiRoutes() });
  base = s.url;
  close = s.close;
});
after(async () => {
  await close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function signedIn(login: string) {
  const jar = new Map<string, string>();
  const send = async (path: string) => {
    const r = await fetch(new URL(path, base), { headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "), accept: "application/json" }, redirect: "manual" });
    for (const c of r.headers.getSetCookie()) {
      const [kv] = c.split(";");
      const k = kv!.slice(0, kv!.indexOf("=")), v = kv!.slice(kv!.indexOf("=") + 1);
      if (/Max-Age=0/.test(c)) jar.delete(k);
      else jar.set(k, v);
    }
    return r;
  };
  const start = await send("/auth/signin?return_to=/");
  const auth = await send(`${start.headers.get("location")}&login=${login}`);
  assert.equal((await send(auth.headers.get("location")!)).status, 303);
  return {
    status: async (path: string) => (await send(path)).status,
    get: async <T>(path: string): Promise<T> => {
      const r = await send(path);
      assert.equal(r.status, 200, path);
      return (await r.json()) as T;
    },
  };
}

const refs = (rows: { repo: string; number: number }[]) => rows.map((r) => `${r.repo}#${r.number}`).sort();

describe("repo visibility", () => {
  test("a viewer without permission sees nothing of the internal repo", async () => {
    const c = await signedIn("outsider");
    assert.deepEqual(await c.get<string[]>("/api/repos"), ["open-app"]);
    assert.deepEqual(refs((await c.get<ItemList>("/api/items?state=all")).rows), ["open-app#1"]);
    assert.deepEqual(refs(await c.get<SearchHit[]>("/api/search?q=wave")), ["open-app#1"]);
    assert.deepEqual(refs(await c.get<SearchHit[]>("/api/search?q=vault%231")), []);
    assert.equal(await c.status("/api/items/vault/1"), 404);
    assert.equal(await c.status("/api/similar/vault/1"), 404);
    const decisions = await c.get<DecisionList>("/api/decisions");
    assert.deepEqual(decisions.decisions.map((d) => d.id), ["open-app#1:scope"]);
    assert.equal(decisions.total, 1);
    assert.equal(await c.status(`/api/decisions/${encodeURIComponent("vault#1:scope")}`), 404);
    assert.equal(await c.status("/api/decisions/batch"), 404);
    assert.deepEqual((await c.get<QueueList>("/api/queue")).rows.map((r) => r.repo), ["open-app"]);
    assert.equal(await c.status("/api/queue?repo=vault"), 404);
    assert.equal(await c.status("/api/flow?repo=vault"), 404);
    const p = await c.get<Progress>("/api/progress");
    assert.deepEqual(p.repos.map((r) => r.repo), ["open-app"]);
    assert.equal(p.funnel.open, 1);
    assert.equal(p.decisionsOpen, 1);
    const runs = await c.get<AgentRunPage>("/api/agents");
    assert.equal(runs.runs.length, 1);
    assert.equal(runs.runs[0]!.items[0]!.repo, "open-app");
    assert.equal(await c.status("/api/agents/2"), 404);
  });

  test("a viewer with read permission, and an operator, see it", async () => {
    for (const login of ["reader", "boss"]) {
      const c = await signedIn(login);
      assert.deepEqual(await c.get<string[]>("/api/repos"), ["open-app", "vault"], login);
      assert.deepEqual(refs((await c.get<ItemList>("/api/items?state=all")).rows), ["open-app#1", "vault#1"], login);
      assert.equal(await c.status("/api/items/vault/1"), 200, login);
      assert.equal((await c.get<DecisionList>("/api/decisions")).total, 3, login);
      assert.deepEqual((await c.get<QueueList>("/api/queue")).rows.map((r) => r.repo), ["open-app", "vault"], login);
      assert.equal((await c.get<Progress>("/api/progress")).funnel.open, 2, login);
      assert.equal(await c.status("/api/flow?repo=vault"), 200, login);
      assert.equal((await c.get<Flow>("/api/flow")).repo, null, login);
    }
  });

  test("agent texts go to operators only", async () => {
    const reader = await signedIn("reader");
    const seen = await reader.get<AgentRunDetail>("/api/agents/2");
    assert.equal(seen.prompt, null);
    assert.equal(seen.output, null);
    const boss = await signedIn("boss");
    const full = await boss.get<AgentRunDetail>("/api/agents/2");
    assert.match(full.prompt ?? "", /prompt for vault/);
    assert.match(full.output ?? "", /output for vault/);
  });
});
