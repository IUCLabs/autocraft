import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { after, before, describe, test } from "node:test";
import { ask, getDecision } from "../src/decisions.ts";
import { connect } from "../src/db.ts";
import { apiRoutes } from "../src/dash/api/index.ts";
import { exportSite } from "../src/dash/pages/export.ts";
import { routes } from "../src/dash/pages/index.ts";
import { doneByRepo, funnelByRepo } from "../src/dash/pages/stats.ts";
import type { Req, Res, Role, User } from "../src/dash/types.ts";
import { isWhitelisted, setOverride } from "../src/whitelist.ts";
import { buildFixture, MARKER, OPERATOR } from "./fixture.ts";

const SCRATCH = join(homedir(), ".cache/craft-automation-scratch");
mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "pages-test-"));

const user = (login: string, role: Role, writable: (repo: string) => boolean): User => ({ login, role, canWrite: async (r) => writable(r) });
const operator = user(OPERATOR, "operator", () => true);
const viewer = user("viewer-test", "viewer", () => false);

function req(u: User, method: "GET" | "POST", path: string, params: Record<string, string> = {}, form: Record<string, string> = {}, query = ""): Req {
  return { method, path, params, query: new URLSearchParams(query), form: new URLSearchParams(form), user: u, csrf: "csrf-token", nonce: "nonce-1" };
}

function handler(method: "GET" | "POST", pattern: string) {
  const r = routes.find((x) => x.method === method && x.pattern === pattern);
  assert.ok(r, `${method} ${pattern}`);
  return r.handler;
}

const call = async (method: "GET" | "POST", pattern: string, rq: Req): Promise<Res> => handler(method, pattern)(db, rq);

let db: DatabaseSync;
let pages: [string, string, Record<string, string>, string][];

before(() => {
  db = buildFixture(join(dir, "fixture.db"));
  pages = [
    ["/classifiers", "/classifiers", {}, ""],
    ["/classifiers/items", "/classifiers/items", {}, "a=haiku&b=jev&field=type_label"], ["/cost", "/cost", {}, ""],
  ];
});
after(() => db?.close());

function checkHtml(html: string) {
  for (const tag of html.match(/<(script|style)\b[^>]*>/g) ?? []) assert.match(tag, /nonce="nonce-1"/, tag);
  for (const f of html.match(/<form method=post[\s\S]*?<\/form>/g) ?? []) assert.match(f, /name=csrf value="csrf-token"/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.doesNotMatch(html, /\son[a-z]+=/i, "no inline event handlers");
}

describe("pages", () => {
  test("every page renders for an operator and a viewer, escaped, with nonces and CSRF fields", async () => {
    for (const u of [operator, viewer]) {
      for (const [pattern, path, params, query] of pages) {
        const res = await call("GET", pattern, req(u, "GET", path, params, {}, query));
        assert.equal(res.status ?? 200, 200, `${u.login} ${path}`);
        checkHtml(res.html!);
      }
    }
  });

  test("each page renders in under 300 ms on the full-scale fixture", async () => {
    for (const [pattern, path, params, query] of pages) {
      const rq = req(operator, "GET", path, params, {}, query);
      await call("GET", pattern, rq);
      const t0 = performance.now();
      await call("GET", pattern, rq);
      const ms = performance.now() - t0;
      assert.ok(ms < 300, `${path}?${query}: ${ms.toFixed(0)} ms`);
    }
  });

  test("the contributors API answers in under 300 ms on the full-scale fixture", async () => {
    const list = apiRoutes().find((r) => r.method === "GET" && r.pattern === "/api/contributors")!;
    const rq = req(operator, "GET", "/api/contributors", {}, {}, "tier=not&sort=rate");
    await list.handler(db, rq);
    const t0 = performance.now();
    const res = await list.handler(db, rq);
    const ms = performance.now() - t0;
    assert.equal(res.status ?? 200, 200);
    assert.ok(ms < 300, `/api/contributors: ${ms.toFixed(0)} ms`);
  });

  test("the export has no write controls and no private field", async () => {
    const out = join(dir, "export");
    const r = await exportSite(db, out);
    assert.equal(r.pages, 2);
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p); else files.push(p);
      }
    };
    walk(out);
    for (const f of files) {
      const html = readFileSync(f, "utf8");
      assert.doesNotMatch(html, /<form/i, f);
      assert.doesNotMatch(html, /<(input|button|select)\b/i, f);
      assert.ok(!html.includes(MARKER), `${f} leaks a private field`);
      assert.ok(!html.includes(SCRATCH), `${f} names a path`);
    }
  });
});

describe("rules", () => {
  let small: DatabaseSync;
  before(() => {
    small = connect(join(dir, "small.db"));
  });
  after(() => small.close());

  test("funnel rules", () => {
    const start = "2026-10-01T00:00:00Z";
    const it = small.prepare("INSERT INTO items (repo, number, kind, state, created_at, closed_at) VALUES ('r', ?, 'pr', ?, '2026-09-01T00:00:00Z', ?)");
    for (let n = 1; n <= 6; n++) it.run(n, "OPEN", null);
    it.run(7, "MERGED", "2026-10-05T00:00:00Z");   // merged by the pipeline
    it.run(8, "CLOSED", "2026-10-05T00:00:00Z");   // closed by the pipeline
    it.run(9, "CLOSED", "2026-10-05T00:00:00Z");   // closed by others
    it.run(10, "MERGED", "2026-09-05T00:00:00Z");  // before the run: not done
    const cls = small.prepare("INSERT INTO classifications (repo, number, classifier, run_id, at) VALUES ('r', ?, ?, 'x', '2026-10-02')");
    cls.run(1, "haiku");
    cls.run(2, "sonnet");
    cls.run(3, "jev");
    const st = small.prepare("INSERT INTO stages (repo, number, stage, at) VALUES ('r', ?, ?, ?)");
    st.run(3, "reviewed", "2026-10-02");
    st.run(3, "take", "2026-10-03");
    st.run(4, "needs-decision", "2026-10-02");
    st.run(4, "batched", "2026-10-03");             // latest wins
    st.run(5, "hold", "2026-10-03");
    st.run(5, "close", "2026-10-02");
    st.run(7, "merged", "2026-10-05");
    st.run(8, "fixed-by-us", "2026-10-05");
    const [f] = funnelByRepo(small);
    assert.deepEqual({ ...f }, { repo: "r", open: 6, classified: 3, reviewed: 2, take: 1, hold: 1, close: 0, needs_decision: 0, batched: 1 });
    const [d] = doneByRepo(small, start);
    assert.deepEqual({ ...d }, { repo: "r", merged_pipeline: 1, closed_pipeline: 1, total: 3, closed_others: 1 });
  });

  test("whitelist tier precedence: overrides win over the rule", () => {
    const it = small.prepare("INSERT INTO items (repo, number, kind, state, author) VALUES ('w', ?, 'pr', ?, ?)");
    let n = 0;
    for (let i = 0; i < 6; i++) it.run(++n, "MERGED", "good");
    it.run(++n, "CLOSED", "good");
    for (let i = 0; i < 6; i++) it.run(++n, "MERGED", "flaky");
    for (let i = 0; i < 6; i++) it.run(++n, "CLOSED", "flaky");
    assert.equal(isWhitelisted(small, "good").ok, true);
    assert.equal(isWhitelisted(small, "flaky").ok, false, "50% is below the 60% rate");
    assert.equal(isWhitelisted(small, "nobody").ok, false);
    setOverride(small, "good", "deny", "private", "cli");
    setOverride(small, "flaky", "allow", null, "cli");
    setOverride(small, "nobody", "allow", null, "cli");
    assert.deepEqual(isWhitelisted(small, "good"), { ok: false, reason: "override: deny" });
    assert.equal(isWhitelisted(small, "flaky").ok, true);
    assert.equal(isWhitelisted(small, "nobody").ok, true);
    setOverride(small, "good", null, null, "cli");
    assert.equal(isWhitelisted(small, "good").ok, true);
    const a = small.prepare("SELECT login, action, details FROM audit WHERE target = 'good' ORDER BY rowid").all() as { login: string; action: string; details: string }[];
    assert.deepEqual(a.map((r) => [r.login, r.action]), [["cli", "override"], ["cli", "override"]]);
    assert.ok(!a.some((r) => r.details.includes("private")));
  });

  test("decisions ask inserts and updates questions but never answers", () => {
    const q = { id: "r#1:scope", kind: "scope", repo: "r", number: 1, question: "Q1?", options: [{ key: "a", label: "A" }, { key: "b", label: "B" }], recommended: "a" };
    assert.deepEqual(ask(small, [q]), { inserted: 1, updated: 0 });
    small.prepare("UPDATE decisions SET answer = 'a', answered_by = 'someone' WHERE id = ?").run(q.id);
    assert.deepEqual(ask(small, [{ ...q, question: "Q2?", answer: "b" }]), { inserted: 0, updated: 1 });
    const d = getDecision(small, q.id)!;
    assert.equal(d.question, "Q2?");
    assert.equal(d.answer, "a");
    assert.throws(() => ask(small, [{ ...q, options: [{ key: "a", label: "A" }] }]), /options/);
  });
});
