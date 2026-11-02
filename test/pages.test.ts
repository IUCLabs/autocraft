import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { after, before, describe, test } from "node:test";
import { ask, getDecision, type DecisionRow } from "../src/decisions.ts";
import { connect } from "../src/db.ts";
import { exportSite } from "../src/dash/pages/export.ts";
import { routes } from "../src/dash/pages/index.ts";
import { doneByRepo, funnelByRepo } from "../src/dash/pages/stats.ts";
import type { Req, Res, User } from "../src/dash/types.ts";
import { isWhitelisted, setOverride } from "../src/whitelist.ts";
import { ADMIN, buildFixture, MARKER } from "./fixture.ts";

const SCRATCH = "/home/user/.cache/craft-automation-scratch";
mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "pages-test-"));

const user = (login: string, role: "admin" | "viewer", writable: (repo: string) => boolean): User => ({ login, role, canWrite: async (r) => writable(r) });
const admin = user(ADMIN, "admin", () => true);
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
  const d = db.prepare("SELECT repo, number FROM decisions WHERE number IS NOT NULL LIMIT 1").get() as { repo: string; number: number };
  pages = [
    ["/", "/", {}, ""], ["/answered", "/answered", {}, ""], ["/progress", "/progress", {}, ""],
    ["/repo/:name", `/repo/${d.repo}`, { name: d.repo }, ""], ["/item/:repo/:n", `/item/${d.repo}/${d.number}`, { repo: d.repo, n: String(d.number) }, ""],
    ["/contributors", "/contributors", {}, ""], ["/classifiers", "/classifiers", {}, ""],
    ["/classifiers/items", "/classifiers/items", {}, "a=haiku&b=jev&field=type_label"], ["/cost", "/cost", {}, ""],
    ["/", "/", {}, "kind=close&age=1&page=2"],
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
  test("every page renders for an admin and a viewer, escaped, with nonces and CSRF fields", async () => {
    for (const u of [admin, viewer]) {
      for (const [pattern, path, params, query] of pages) {
        const res = await call("GET", pattern, req(u, "GET", path, params, {}, query));
        assert.equal(res.status ?? 200, 200, `${u.login} ${path}`);
        checkHtml(res.html!);
      }
    }
    // the fixture's hostile titles are shown escaped
    const evil = db.prepare("SELECT repo, number FROM items WHERE title LIKE '<script>%' LIMIT 1").get() as { repo: string; number: number };
    const res = await call("GET", "/item/:repo/:n", req(viewer, "GET", "/item", { repo: evil.repo, n: String(evil.number) }));
    assert.match(res.html!, /&lt;script&gt;alert/);
  });

  test("each page renders in under 300 ms on the full-scale fixture", async () => {
    for (const [pattern, path, params, query] of pages) {
      const rq = req(admin, "GET", path, params, {}, query);
      await call("GET", pattern, rq);
      const t0 = performance.now();
      await call("GET", pattern, rq);
      const ms = performance.now() - t0;
      assert.ok(ms < 300, `${path}?${query}: ${ms.toFixed(0)} ms`);
    }
  });

  const openSingle = (): DecisionRow => db.prepare("SELECT * FROM decisions WHERE answer IS NULL AND number IS NOT NULL LIMIT 1").get() as DecisionRow;

  test("a non-operator's and a no-write operator's answer gets 403; the card says why", async () => {
    const d = openSingle();
    const maint = user("maint", "viewer", () => true);
    const op = user("op", "admin", (r) => r !== d.repo);
    for (const [u, why] of [[viewer, /Only the operator/], [maint, /Only the operator/], [op, new RegExp(`storytold/${d.repo}`)]] as const) {
      const res = await call("POST", "/decisions/answer", req(u, "POST", "/decisions/answer", {}, { id: d.id, answer: d.recommended! }));
      assert.equal(res.status, 403);
      assert.match(res.html!, why);
      const home = await call("GET", "/", req(u, "GET", "/", {}, {}, `repo=${d.repo}`));
      assert.doesNotMatch(home.html!, /action="\/decisions\/answer"/);
    }
    assert.equal(getDecision(db, d.id)!.answer, null);
    const home = await call("GET", "/", req(op, "GET", "/", {}, {}, `repo=${d.repo}`));
    assert.match(home.html!, /You can&#39;t answer this/);
  });

  test("answer, undo, answer again", async () => {
    const d = openSingle();
    const m = user("op", "admin", (r) => r === d.repo);
    const r1 = await call("POST", "/decisions/answer", req(m, "POST", "/decisions/answer", {}, { id: d.id, answer: d.recommended!, note: `n ${MARKER}`, js: "1" }));
    assert.equal(r1.status ?? 200, 200);
    assert.match(r1.html!, /Answered/);
    assert.match(r1.html!, /decisions\/undo/);
    assert.equal(getDecision(db, d.id)!.answered_by, "op");
    const again = await call("POST", "/decisions/answer", req(m, "POST", "/decisions/answer", {}, { id: d.id, answer: d.recommended! }));
    assert.equal(again.status, 409);
    const r2 = await call("POST", "/decisions/undo", req(m, "POST", "/decisions/undo", {}, { id: d.id, back: "/" }));
    assert.equal(r2.redirect, "/");
    assert.equal(getDecision(db, d.id)!.answer, null);
    const other = JSON.parse(d.options).find((o: { key: string }) => o.key !== d.recommended).key;
    const r3 = await call("POST", "/decisions/answer", req(m, "POST", "/decisions/answer", {}, { id: d.id, answer: other, back: "/" }));
    assert.match(r3.redirect!, /^\/\?done=/);
    assert.equal(getDecision(db, d.id)!.answer, other);
    const acts = (db.prepare("SELECT action FROM audit WHERE target = ? ORDER BY rowid").all(d.id) as { action: string }[]).map((r) => r.action);
    assert.deepEqual(acts, ["answer", "undo", "answer"]);
    assert.ok(!(db.prepare("SELECT details FROM audit WHERE target = ?").all(d.id) as { details: string }[]).some((r) => r.details.includes(MARKER)), "audit has no note text");
    // once applied, undo is refused
    db.prepare("UPDATE decisions SET applied_at = ? WHERE id = ?").run(new Date().toISOString(), d.id);
    const r4 = await call("POST", "/decisions/undo", req(m, "POST", "/decisions/undo", {}, { id: d.id }));
    assert.equal(r4.status, 409);
  });

  test("a batch with one non-writable repo is refused; with all repos writable it records exceptions", async () => {
    const b = db.prepare("SELECT * FROM decisions WHERE number IS NULL AND repo IS NULL AND answer IS NULL LIMIT 1").get() as DecisionRow;
    const refs = JSON.parse(b.items!) as { repo: string; number: number }[];
    const blockedRepo = refs[refs.length - 1].repo;
    const partial = user("op", "admin", (r) => r !== blockedRepo);
    const res = await call("POST", "/decisions/answer", req(partial, "POST", "/decisions/answer", {}, { id: b.id, answer: "close" }));
    assert.equal(res.status, 403);
    assert.match(res.html!, new RegExp(blockedRepo));
    const full = user("op", "admin", () => true);
    const ex = `ex:${refs[0].repo}#${refs[0].number}`;
    const ok = await call("POST", "/decisions/answer", req(full, "POST", "/decisions/answer", {}, { id: b.id, answer: "close", [ex]: "keep" }));
    assert.ok(ok.redirect);
    assert.deepEqual(JSON.parse(getDecision(db, b.id)!.exceptions!), [{ ...refs[0], answer: "keep" }]);
  });

  test("the whitelist routes refuse non-admins", async () => {
    const res = await call("POST", "/contributors/override", req(viewer, "POST", "/contributors/override", {}, { login: "user0001", status: "allow" }));
    assert.equal(res.status, 403);
    const ok = await call("POST", "/contributors/override", req(admin, "POST", "/contributors/override", {}, { login: "user0001", status: "allow", note: "hi" }));
    assert.equal(ok.redirect, "/contributors");
    assert.equal(isWhitelisted(db, "user0001").ok, true);
  });

  test("the export has no write controls and no private field", async () => {
    const out = join(dir, "export");
    const r = await exportSite(db, out);
    assert.ok(r.pages > 20);
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
