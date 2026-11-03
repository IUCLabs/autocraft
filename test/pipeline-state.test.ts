// The pipeline switch and stage limits over HTTP: everyone signed in reads;
// only operators write; bodies are validated and every write is audited.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { PipelineState, StageLimit } from "../web/src/api/types.ts";
import { SCRATCH } from "./scratch.ts";

process.env.AUTOCRAFT_EXTRA_STEPS = fileURLToPath(new URL("./runner-steps.ts", import.meta.url));

const { addLogin } = await import("../src/access.ts");
const { connect } = await import("../src/db.ts");
const { scopeToTracked } = await import("../src/repos.ts");
const { apiRoutes } = await import("../src/dash/api/index.ts");
const { loadConfig } = await import("../src/dash/server/config.ts");
const { startServer } = await import("../src/dash/server/index.ts");
const { FakeProvider } = await import("../src/dash/server/provider.ts");

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "pipeline-state-test-"));
const dbFile = join(dir, "dash.db");
const permsFile = join(dir, "perms.json");
writeFileSync(permsFile, "{}");

const db = connect(dbFile);
let base = "";
let close: () => Promise<void>;

before(async () => {
  addLogin(db, "cli", "boss", "operator", null);
  addLogin(db, "cli", "viewer1", "viewer", null);
  addLogin(db, "cli", "maint", "maintainer", null);
  scopeToTracked(db);
  const config = loadConfig({ AUTOCRAFT_DEV_AUTH: "1", AUTOCRAFT_LISTEN: "127.0.0.1:0", AUTOCRAFT_DB: dbFile, AUTOCRAFT_DEV_PERMS: permsFile });
  const s = await startServer({ config, db, provider: new FakeProvider(permsFile), routes: apiRoutes() });
  base = s.url;
  close = s.close;
});
after(async () => {
  await close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

class Client {
  jar = new Map<string, string>();
  csrf = "";
  async req(method: string, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = { cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "), accept: "application/json" };
    if (method !== "GET") headers["x-csrf-token"] = this.csrf;
    if (body !== undefined) headers["content-type"] = "application/json";
    const r = await fetch(new URL(path, base), { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
    for (const c of r.headers.getSetCookie()) {
      const [kv] = c.split(";");
      const k = kv!.slice(0, kv!.indexOf("=")), v = kv!.slice(kv!.indexOf("=") + 1);
      if (/Max-Age=0/.test(c)) this.jar.delete(k);
      else this.jar.set(k, v);
    }
    return r;
  }
  async json<T>(method: string, path: string, body?: unknown, status = 200): Promise<T> {
    const r = await this.req(method, path, body);
    const text = await r.text();
    assert.equal(r.status, status, `${method} ${path}: ${text}`);
    return (text ? JSON.parse(text) : undefined) as T;
  }
  get = <T>(path: string, status = 200) => this.json<T>("GET", path, undefined, status);
  post = <T>(path: string, body?: unknown, status = 200) => this.json<T>("POST", path, body, status);
  put = <T>(path: string, body?: unknown, status = 200) => this.json<T>("PUT", path, body, status);
}

async function signedIn(login: string): Promise<Client> {
  const c = new Client();
  const start = await c.req("GET", "/auth/signin?return_to=/");
  const auth = await c.req("GET", `${start.headers.get("location")}&login=${login}`);
  const done = await c.req("GET", auth.headers.get("location")!);
  assert.equal(done.status, 303, `sign-in of ${login}`);
  c.csrf = (await c.req("GET", "/api/me")).headers.get("x-csrf-token") ?? "";
  return c;
}


const audits = (action: string) => (db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = ?").get(action) as { n: number }).n;

describe("pipeline state api", () => {
  test("everyone signed in reads the state; the pipeline starts off with the default limits", async () => {
    for (const login of ["viewer1", "maint", "boss"]) {
      const s = await (await signedIn(login)).get<PipelineState>("/api/pipeline/state");
      assert.equal(s.enabled, false);
      const steps = s.limits.map((l) => l.step);
      assert.equal(new Set(steps).size, steps.length);
      for (const step of ["classify-new", "embed", "decide", "review-batch", "merge", "opus-review", "review-post", "dupes-compare", "conversation"]) assert.ok(steps.includes(step), step);
      const by = (step: string) => s.limits.find((l) => l.step === step)!;
      assert.deepEqual([by("classify-new").perDay, by("embed").perDay, by("decide").perDay, by("review-batch").perDay, by("merge").perDay, by("opus-review").perDay, by("review-post").perDay, by("dupes-compare").perDay], [2000, null, 100, 40, 10, 40, 40, 200]);
      assert.equal(by("decide").usedToday, 0);
    }
  });

  test("non-operators get 403 and nothing is audited", async () => {
    const before = audits("pipeline-switch") + audits("stage-limit");
    for (const login of ["viewer1", "maint"]) {
      const c = await signedIn(login);
      await c.put("/api/pipeline/state", { enabled: true }, 403);
      await c.put("/api/pipeline/limits/decide", { perDay: 5 }, 403);
    }
    assert.equal(audits("pipeline-switch") + audits("stage-limit"), before);
    assert.equal((await (await signedIn("boss")).get<PipelineState>("/api/pipeline/state")).enabled, false);
  });

  test("an operator turns the pipeline on and off and sets limits, each audited; bad bodies are refused", async () => {
    const boss = await signedIn("boss");
    await boss.put("/api/pipeline/state", { enabled: "yes" }, 400);
    await boss.put("/api/pipeline/state", {}, 400);
    const on = await boss.put<PipelineState>("/api/pipeline/state", { enabled: true });
    assert.deepEqual([on.enabled, on.changedBy], [true, "boss"]);
    assert.ok(on.changedAt);
    assert.equal((await boss.put<PipelineState>("/api/pipeline/state", { enabled: false })).enabled, false);
    assert.equal(audits("pipeline-switch"), 2);

    const l = await boss.put<StageLimit>("/api/pipeline/limits/decide", { perDay: 7 });
    assert.equal(l.perDay, 7);
    assert.equal((await boss.put<StageLimit>("/api/pipeline/limits/decide", { perDay: null })).perDay, null);
    assert.match((await boss.put<StageLimit>("/api/pipeline/limits/merge", { perDay: 0 })).pausedReason ?? "", /limit is 0/);
    const before = audits("stage-limit");
    for (const body of [{ perDay: -1 }, { perDay: 1.5 }, { perDay: "3" }, { perDay: 1e9 }, {}, { perDay: 1, usdPerDay: 3 }, [1]]) {
      await boss.put("/api/pipeline/limits/decide", body, 400);
    }
    await boss.put("/api/pipeline/limits/classify-all", { perDay: 1 }, 404);
    assert.equal(audits("stage-limit"), before);
  });
});
