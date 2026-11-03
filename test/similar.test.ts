// Item embeddings with a fake embedder (no model download): only new and
// changed items are embedded, similar items rank a near-duplicate first, the
// semantic search hit shape, and that both endpoints need a session.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { SimilarHit } from "../web/src/api/types.ts";
import { addLogin } from "../src/access.ts";
import { connect } from "../src/db.ts";
import { scopeToTracked } from "../src/repos.ts";
import { apiRoutes } from "../src/dash/api/index.ts";
import { loadConfig } from "../src/dash/server/config.ts";
import { startServer } from "../src/dash/server/index.ts";
import { FakeProvider } from "../src/dash/server/provider.ts";
import { normalize, type Embedder } from "../src/embed/model.ts";
import { embedItems } from "../src/embed/store.ts";
import { SCRATCH } from "./scratch.ts";

// Bag of words hashed into 64 dimensions: texts sharing words score high.
function fakeEmbedder(id = "fake:1"): Embedder & { seen: string[] } {
  const seen: string[] = [];
  return {
    id, dim: 64, seen,
    async embed(texts) {
      seen.push(...texts);
      return texts.map((t) => {
        const v = new Float32Array(64);
        for (const w of t.toLowerCase().match(/[a-z]+/g) ?? []) v[createHash("md5").update(w).digest()[0]! % 64]! += 1;
        return normalize(v);
      });
    },
  };
}

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "similar-test-"));
const dbFile = join(dir, "dash.db");
const permsFile = join(dir, "perms.json");
writeFileSync(permsFile, "{}");
const db = connect(dbFile);
let base = "";
let close: () => Promise<void>;

before(async () => {
  const now = new Date().toISOString();
  const ins = db.prepare("INSERT INTO items (repo, number, kind, state, state_reason, title, body, author, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)");
  ins.run("photocraft", 1, "issue", "OPEN", null, "Crash when exporting a layered TIFF", "Exporting a TIFF with layers crashes the app", "alice", now, now);
  ins.run("photocraft", 2, "pr", "OPEN", null, "Add ripple distortion filter", "New ripple filter under Distort", "bob", now, now);
  ins.run("filmcraft", 3, "issue", "CLOSED", "DUPLICATE", "App crashes exporting layered TIFF files", "Crash on export of TIFF with layers <!-- template -->", "carol", now, now);
  ins.run("filmcraft", 4, "issue", "OPEN", null, "Timeline audio drifts after an hour", "Audio drift on long timelines", "dave", now, now);
  ins.run("untracked-repo", 5, "issue", "OPEN", null, "Crash when exporting a layered TIFF", "same words", "erin", now, now);
  db.prepare("INSERT INTO classifications (repo, number, classifier, run_id, at, type_label, probs) VALUES ('filmcraft', 3, 'jev', 'r1', ?, 'bugfix', ?)").run(now, JSON.stringify({ top: 0.95 }));
  db.prepare("INSERT INTO classifications (repo, number, classifier, run_id, at, type_label) VALUES ('filmcraft', 3, 'haiku', 'r1', ?, 'infra')").run(now);
  db.exec("INSERT OR REPLACE INTO repos (name, visibility) VALUES ('photocraft', 'public'), ('filmcraft', 'public')");
  db.exec("DELETE FROM tracked_repos");
  db.exec("INSERT INTO tracked_repos (name, pipeline) VALUES ('photocraft', 1), ('filmcraft', 1)");
  addLogin(db, "cli", "viewer1", "viewer", null);
  await embedItems(db, fakeEmbedder());
  scopeToTracked(db);
  const config = loadConfig({ AUTOCRAFT_DEV_AUTH: "1", AUTOCRAFT_LISTEN: "127.0.0.1:0", AUTOCRAFT_DB: dbFile, AUTOCRAFT_DEV_PERMS: permsFile });
  const s = await startServer({ config, db, provider: new FakeProvider(permsFile), routes: apiRoutes({ embedder: fakeEmbedder() }) });
  base = s.url;
  close = s.close;
});
after(async () => {
  await close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function signedIn(login: string): Promise<(path: string) => Promise<Response>> {
  const jar = new Map<string, string>();
  const req = async (path: string): Promise<Response> => {
    const r = await fetch(new URL(path, base), { headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "), accept: "application/json" }, redirect: "manual" });
    for (const c of r.headers.getSetCookie()) {
      const [kv] = c.split(";");
      jar.set(kv!.slice(0, kv!.indexOf("=")), kv!.slice(kv!.indexOf("=") + 1));
    }
    return r;
  };
  const start = await req("/auth/signin?return_to=/");
  const auth = await req(`${start.headers.get("location")}&login=${login}`);
  assert.equal((await req(auth.headers.get("location")!)).status, 303);
  return req;
}

describe("item embeddings", () => {
  test("only new and changed tracked items are embedded again", async () => {
    const stored = (db.prepare("SELECT repo || '#' || number AS k FROM main.item_embeddings ORDER BY k").all() as { k: string }[]).map((r) => r.k);
    assert.deepEqual(stored, ["filmcraft#3", "filmcraft#4", "photocraft#1", "photocraft#2"]);
    const e = fakeEmbedder();
    assert.equal((await embedItems(db, e)).embedded, 0);
    db.prepare("UPDATE main.items SET body = 'Audio drifts out of sync on long timelines' WHERE repo = 'filmcraft' AND number = 4").run();
    db.prepare("UPDATE main.items SET updated_at = 'x' WHERE repo = 'photocraft' AND number = 2").run();
    assert.equal((await embedItems(db, e)).embedded, 1);
    assert.match(e.seen[0]!, /^Timeline audio drifts after an hour\nAudio drifts/);
    assert.equal((await embedItems(db, fakeEmbedder("fake:2"))).embedded, 4, "another model embeds everything");
    assert.equal((await embedItems(db, fakeEmbedder("fake:1"), { all: true })).embedded, 4);
  });

  test("signed out: 401", async () => {
    for (const path of ["/api/similar/photocraft/1", "/api/search?q=crash&mode=semantic"]) {
      assert.equal((await fetch(new URL(path, base), { headers: { accept: "application/json" } })).status, 401, path);
    }
  });

  test("similar ranks the near-duplicate first, across repos, without the item itself", async () => {
    const get = await signedIn("viewer1");
    const r = await get("/api/similar/photocraft/1?limit=3");
    assert.equal(r.status, 200);
    const hits = (await r.json()) as SimilarHit[];
    assert.equal(hits.length, 3);
    assert.deepEqual(hits[0], {
      repo: "filmcraft", number: 3, kind: "issue", title: "App crashes exporting layered TIFF files", author: "carol",
      state: "closed", score: hits[0]!.score, stateReason: "duplicate", label: "bugfix", labelBy: "jev",
    });
    assert.ok(hits[0]!.score > hits[1]!.score);
    assert.ok(!hits.some((h) => h.repo === "untracked-repo" || (h.repo === "photocraft" && h.number === 1)));
    assert.equal((await get("/api/similar/untracked-repo/5")).status, 404);
  });

  test("semantic search returns search hits with a score", async () => {
    const get = await signedIn("viewer1");
    const hits = (await (await get("/api/search?q=ripple+distortion&mode=semantic")).json()) as SimilarHit[];
    assert.equal(hits[0]!.repo, "photocraft");
    assert.equal(hits[0]!.number, 2);
    assert.equal(hits[0]!.kind, "pr");
    assert.equal(typeof hits[0]!.score, "number");
    assert.deepEqual(await (await get("/api/search?q=&mode=semantic")).json(), []);
  });
});
