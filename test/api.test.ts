// The JSON API through HTTP with the fake OAuth provider: who may answer,
// adopt, give feedback (a pick, text or both); CSRF; the hourly limit; claims; and that feedback
// never reaches the CLI output the pipeline reads.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { Decision, DecisionComment, Item, Progress, SearchHit, User } from "../web/src/api/types.ts";
import { addLogin } from "../src/access.ts";
import { connect } from "../src/db.ts";
import { ask } from "../src/decisions.ts";
import { scopeToTracked } from "../src/repos.ts";
import { apiRoutes } from "../src/dash/api/index.ts";
import { loadConfig } from "../src/dash/server/config.ts";
import { startServer } from "../src/dash/server/index.ts";
import { FakeProvider } from "../src/dash/server/provider.ts";
import { SCRATCH } from "./scratch.ts";

const MARKER = "OPINION-MARKER-k3v";
const LIMIT = 8;
mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "api-test-"));
const dbFile = join(dir, "dash.db");
const permsFile = join(dir, "perms.json");
writeFileSync(permsFile, JSON.stringify({ boss: { photocraft: "admin" }, maint: { photocraft: "write" } }));

const db = connect(dbFile);
let base = "";
let close: () => Promise<void>;

const OPTS = [{ key: "small", label: "Small extra" }, { key: "plugin", label: "Plugin candidate" }];
const P1 = "photocraft#1:scope", P2 = "photocraft#2:scope", F3 = "filmcraft#3:scope", P4 = "photocraft#4:close";

before(async () => {
  const now = new Date().toISOString();
  const ins = db.prepare("INSERT INTO items (repo, number, kind, state, title, body, author, created_at, updated_at, closing_issues) VALUES (?,?,?,?,?,?,?,?,?,?)");
  ins.run("photocraft", 1, "pr", "OPEN", "Add wave filter", "<script>x</script> body", "alice", now, now, "[5]");
  ins.run("photocraft", 2, "pr", "OPEN", "Add ripple filter", "b", "bob", now, now, null);
  ins.run("filmcraft", 3, "pr", "OPEN", "Fix audio drift", "c", "carol", now, now, null);
  ins.run("photocraft", 4, "issue", "OPEN", "Crash on save", "d", "dave", now, now, null);
  ins.run("photocraft", 5, "issue", "OPEN", "Wave filter missing", "e", "erin", now, now, null);
  ins.run("untracked-repo", 6, "pr", "OPEN", "Add wave filter elsewhere", "f", "frank", now, now, null);
  db.prepare("UPDATE items SET additions = 40, deletions = 3, changed_files = 7 WHERE repo = 'photocraft' AND number = 1").run();
  db.prepare("INSERT INTO comments (repo, number, id, kind, author, created_at, body) VALUES ('photocraft', 1, 'c1', 'comment', 'alice', ?, 'looks good')").run(now);
  db.prepare("INSERT INTO classifications (repo, number, classifier, run_id, at, type_label, want, reason) VALUES ('photocraft', 1, 'haiku', 'r1', ?, 'small extra', 'yes', 'adds a filter')").run(now);
  db.exec("INSERT OR REPLACE INTO repos (name, visibility) VALUES ('photocraft', 'public'), ('filmcraft', 'public')");
  ask(db, [P1, P2, F3, P4].map((id) => {
    const [repo, rest] = id.split("#");
    return { id, kind: id.endsWith("close") ? "close" : "scope", repo, number: Number(rest!.split(":")[0]), question: "Small extra or plugin?", options: OPTS, recommended: "small", summary: "Adds a filter." };
  }));
  ask(db, [{ id: "photocraft:dupegroup:4", kind: "duplicate", repo: "photocraft", number: 4, question: "Keep #4 and close #5?", options: [{ key: "accept", label: "Use this answer" }, { key: "distinct", label: "Not duplicates" }], recommended: "accept" }]);
  addLogin(db, "cli", "boss", "operator", null);
  addLogin(db, "cli", "viewer1", "viewer", null);
  addLogin(db, "cli", "maint", "maintainer", null);
  addLogin(db, "cli", "chatty", "maintainer", null);
  addLogin(db, "cli", "pal", "maintainer", null);
  scopeToTracked(db);
  const config = loadConfig({ AUTOCRAFT_DEV_AUTH: "1", AUTOCRAFT_LISTEN: "127.0.0.1:0", AUTOCRAFT_DB: dbFile, AUTOCRAFT_DEV_PERMS: permsFile });
  const s = await startServer({ config, db, provider: new FakeProvider(permsFile), routes: apiRoutes({ writesPerHour: LIMIT }) });
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
  async req(method: string, path: string, opts: { body?: unknown; csrf?: string | null; headers?: Record<string, string> } = {}): Promise<Response> {
    const headers: Record<string, string> = { cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "), accept: "application/json", ...opts.headers };
    const csrf = opts.csrf === undefined ? this.csrf : opts.csrf;
    if (method === "POST" && csrf !== null) headers["x-csrf-token"] = csrf;
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(opts.body);
    }
    const r = await fetch(new URL(path, base), { method, headers, body, redirect: "manual" });
    for (const c of r.headers.getSetCookie()) {
      const [kv] = c.split(";");
      const k = kv!.slice(0, kv!.indexOf("=")), v = kv!.slice(kv!.indexOf("=") + 1);
      if (/Max-Age=0/.test(c)) this.jar.delete(k);
      else this.jar.set(k, v);
    }
    return r;
  }
  async json<T>(method: string, path: string, body?: unknown, status = 200): Promise<T> {
    const r = await this.req(method, path, { body });
    const text = await r.text();
    assert.equal(r.status, status, `${method} ${path}: ${text}`);
    return (text ? JSON.parse(text) : undefined) as T;
  }
  get = <T>(path: string) => this.json<T>("GET", path);
  post = <T>(path: string, body?: unknown, status = 200) => this.json<T>("POST", path, body, status);
}

const dpath = (id: string, tail = "") => `/api/decisions/${encodeURIComponent(id)}${tail}`;

async function signedIn(login: string): Promise<Client> {
  const c = new Client();
  const start = await c.req("GET", "/auth/signin?return_to=/");
  const auth = await c.req("GET", `${start.headers.get("location")}&login=${login}`);
  const done = await c.req("GET", auth.headers.get("location")!);
  assert.equal(done.status, 303, `sign-in of ${login}`);
  const me = await c.req("GET", "/api/me");
  c.csrf = me.headers.get("x-csrf-token") ?? "";
  assert.ok(c.csrf);
  return c;
}

const auditCount = (action: string, login: string) =>
  (db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = ? AND login = ?").get(action, login) as { n: number }).n;

describe("api", () => {
  test("without a session every endpoint answers 401 JSON", async () => {
    const c = new Client();
    const r = await c.req("GET", "/api/me");
    assert.equal(r.status, 401);
    assert.deepEqual(await r.json(), { error: "sign-in required" });
    for (const path of ["/api/classifiers", "/api/classifiers/disagreements", "/api/cost", "/api/items", "/api/items?q=wave"]) assert.equal((await c.req("GET", path)).status, 401, path);
    assert.equal((await c.req("POST", dpath(P1, "/feedback"), { body: { option: "small" }, csrf: "x" })).status, 401);
  });

  test("me and reads: role, write repos, item, search and progress", async () => {
    const boss = await signedIn("boss");
    const me = await boss.get<User>("/api/me");
    assert.equal(me.role, "operator");
    assert.deepEqual(me.writeRepos, ["photocraft"]);
    assert.equal((await (await signedIn("maint")).get<User>("/api/me")).role, "maintainer");
    const it = await boss.get<Item>("/api/items/photocraft/1");
    assert.equal(it.body, "<script>x</script> body");
    assert.deepEqual([it.changedFiles, it.additions, it.deletions], [7, 40, 3]);
    assert.equal((await boss.get<Item>("/api/items/photocraft/4")).changedFiles, null);
    assert.deepEqual([it.verification, it.fixups, it.actions], [null, [], []]);
    db.prepare("UPDATE main.items SET head_oid = 'h1' WHERE repo = 'photocraft' AND number = 1").run();
    db.prepare(`INSERT INTO verifications (repo, number, head_sha, kind, reason, plan, state, summary, created_at)
      VALUES ('photocraft', 1, 'h1', 'tests', 'why', '{"kind":"tests","crates":["codecs"],"tests":["png::"]}', 'failed', 'test failed', '2026-01-01T00:00:00Z')`).run();
    db.prepare("INSERT INTO fixups (repo, number, from_head, state, reason, files, attempt, created_at) VALUES ('photocraft', 1, 'h0', 'refused', 'no', '[\"a.rs\"]', 1, '2026-01-01T00:00:00Z')").run();
    db.prepare("INSERT INTO actions (decision_id, repo, number, kind, state, comment_url, created_at) VALUES ('d1', 'photocraft', 1, 'comment-close', 'done', 'https://x/c', '2026-01-01T00:00:00Z')").run();
    const worked = await boss.get<Item>("/api/items/photocraft/1");
    assert.deepEqual([worked.verification?.state, worked.verification?.current, worked.verification?.plan], ["failed", true, { crates: ["codecs"], tests: ["png::"], testLines: null }]);
    assert.deepEqual([worked.fixups[0]?.files, worked.fixups[0]?.state, worked.actions[0]?.commentUrl], [["a.rs"], "refused", "https://x/c"]);
    assert.deepEqual(it.comments.map((c) => c.body), ["looks good"]);
    assert.deepEqual(it.decisionIds, [P1]);
    assert.deepEqual(it.related.map((r) => [r.number, r.relation]), [[5, "fixes"]]);
    assert.equal(it.classifications[0]!.typeLabel, "small extra");
    assert.equal((await boss.req("GET", "/api/items/untracked-repo/6")).status, 404);
    const byRef = await boss.get<SearchHit[]>("/api/search?q=photocraft%231");
    assert.deepEqual(byRef.map((h) => h.number), [1]);
    const byWords = await boss.get<SearchHit[]>("/api/search?q=wave%20filter");
    assert.deepEqual(byWords.map((h) => `${h.repo}#${h.number}`).sort(), ["photocraft#1", "photocraft#5"]);
    const p = await boss.get<Progress>("/api/progress");
    assert.equal(p.funnel.open, 5);
    assert.equal(p.decisionsOpen, 5);
    assert.equal(p.perHour.length, 24);
  });

  test("a readable link finds the item's first open decision in inbox order, or null", async () => {
    const boss = await signedIn("boss");
    const forItem = (repo: string, n: number) => boss.get<Decision | null>(`/api/items/${encodeURIComponent(repo)}/${n}/decision`);
    assert.equal((await forItem("photocraft", 1))?.id, P1);
    assert.equal((await forItem("photocraft", 4))?.id, "photocraft:dupegroup:4", "duplicate comes before close");
    assert.equal((await forItem("storytold/photocraft", 1))?.id, P1, "the full repo name works too");
    const ofKind = (n: number, kind: string) => boss.get<Decision | null>(`/api/items/photocraft/${n}/decision?kind=${kind}`);
    assert.equal((await ofKind(4, "close"))?.id, P4, "the kind picks that decision");
    assert.equal(await ofKind(4, "merge"), null);
    assert.equal(await forItem("photocraft", 999), null);
    assert.equal(await forItem("untracked-repo", 6), null);
  });

  test("a viewer's opinion, retract, comment and claim are refused and write nothing; a maintainer's succeed", async () => {
    const viewer = await signedIn("viewer1");
    const maint = await signedIn("maint");
    const pal = await signedIn("pal");
    for (const c of [viewer, maint]) {
      await c.post(dpath(P1, "/answer"), { answer: "small" }, 403);
      await c.post(dpath(P1, "/undo"), undefined, 403);
    }
    const audits = () => (db.prepare("SELECT COUNT(*) AS n FROM audit WHERE login = 'viewer1'").get() as { n: number }).n;
    const before = audits();
    await viewer.post(dpath(P1, "/feedback"), { option: "plugin", text: `viewer ${MARKER}` }, 403);
    await viewer.post(dpath(P1, "/feedback"), { text: `viewer ${MARKER}` }, 403);
    await viewer.post(dpath(P1, "/retract"), undefined, 403);
    await viewer.post(dpath(P1, "/claim"), undefined, 403);
    assert.equal(audits(), before);
    assert.equal((await maint.get<Decision>(dpath(P1))).opinions.some((o) => o.login === "viewer1"), false);
    assert.equal((await maint.get<DecisionComment[]>(dpath(P1, "/thread"))).length, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM decision_claims WHERE login = 'viewer1'").get() as { n: number }).n, 0);

    const d1 = await pal.post<Decision>(dpath(P1, "/feedback"), { option: "plugin", text: `pal ${MARKER}` });
    const pOp = d1.opinions.find((o) => o.login === "pal")!;
    assert.equal(pOp.permission, "none");
    await maint.post(dpath(P1, "/adopt"), { opinionId: pOp.id }, 403);
    const d2 = await maint.post<Decision>(dpath(P1, "/feedback"), { option: "small" });
    assert.equal(d2.opinions.find((o) => o.login === "maint")!.permission, "write");
    // changing replaces the live opinion
    const d3 = await maint.post<Decision>(dpath(P1, "/feedback"), { option: "plugin", text: `maint ${MARKER}` });
    assert.deepEqual(d3.opinions.filter((o) => o.login === "maint").map((o) => o.option), ["plugin"]);
    // a new pick without text keeps the earlier note; with text it replaces it
    const d3b = await maint.post<Decision>(dpath(P1, "/feedback"), { option: "small" });
    assert.deepEqual(d3b.opinions.filter((o) => o.login === "maint").map((o) => [o.option, o.note]), [["small", `maint ${MARKER}`]]);
    const d3c = await maint.post<Decision>(dpath(P1, "/feedback"), { option: "plugin", text: "changed" });
    assert.equal(d3c.opinions.find((o) => o.login === "maint")!.note, "changed");
    await pal.post(dpath(P1, "/feedback"), { option: "nope" }, 400);
    await pal.post(dpath(P1, "/feedback"), {}, 400);
    const d5 = await pal.post<Decision>(dpath(P1, "/feedback"), { text: `comment ${MARKER}` });
    assert.equal(d5.opinions.filter((o) => o.login === "pal").length, 1, "text alone is no pick");
    assert.deepEqual((await maint.get<DecisionComment[]>(dpath(P1, "/thread"))).map((x) => x.body), [`comment ${MARKER}`]);
    assert.equal((await maint.get<Decision>(dpath(P1))).commentCount, 1);
    const d4 = await pal.post<Decision>(dpath(P1, "/retract"));
    assert.equal(d4.opinions.some((o) => o.login === "pal"), false);
    assert.equal(getAnswer(P1), null);
    assert.equal(auditCount("opinion", "maint"), 4);
    assert.equal(auditCount("comment", "pal"), 1);
    assert.equal(auditCount("opinion-retract", "pal"), 1);
  });

  test("an operator without write on the repo can't answer; with it, answer and undo work and the note stays private", async () => {
    const boss = await signedIn("boss");
    const r = await boss.req("POST", dpath(F3, "/answer"), { body: { answer: "small" } });
    assert.equal(r.status, 403);
    assert.match(((await r.json()) as { error: string }).error, /storytold\/filmcraft/);
    const d = await boss.post<Decision>(dpath(P2, "/answer"), { answer: "plugin", note: "private note" });
    assert.equal(d.answer, "plugin");
    assert.equal(d.answerNote, "private note");
    const seen = await (await signedIn("viewer1")).get<Decision>(dpath(P2));
    assert.equal(seen.answer, "plugin");
    assert.equal(seen.answerNote, null);
    await boss.post(dpath(P2, "/answer"), { answer: "small" }, 409);
    const u = await boss.post<Decision>(dpath(P2, "/undo"));
    assert.equal(u.answer, null);
    assert.equal(auditCount("undo", "boss"), 1);
  });

  test("a group decision's answer must carry the hash of the shown comments, and an answer Act wrote for can't be undone", async () => {
    const boss = await signedIn("boss");
    const id = "photocraft:dupegroup:4";
    db.prepare("INSERT INTO dupe_groups (decision_id, repo, source) VALUES (?, 'photocraft', 'model')").run(id);
    db.prepare("INSERT INTO dupe_group_texts (decision_id, option, number, step, text) VALUES (?, 'accept', 5, 'close', 'Closing as a duplicate of #4.')").run(id);
    const shown = await boss.get<Decision>(dpath(id));
    const ot = shown.optionTexts.find((o) => o.option === "accept")!;
    assert.equal(ot.texts[0]!.text, "Closing as a duplicate of #4.");
    await boss.post(dpath(id, "/answer"), { answer: "accept" }, 409);
    await boss.post(dpath(id, "/answer"), { answer: "accept", textsHash: "stale" }, 409);
    // The comments changed after the page was loaded.
    db.prepare("UPDATE dupe_group_texts SET text = 'Closing as a duplicate of #4.\nParts to carry over to #4: x.' WHERE decision_id = ?").run(id);
    await boss.post(dpath(id, "/answer"), { answer: "accept", textsHash: ot.hash }, 409);
    const fresh = (await boss.get<Decision>(dpath(id))).optionTexts[0]!;
    // Adopting an opinion approves the same texts, so it needs the same hash.
    db.prepare("INSERT INTO decision_opinions (id, decision_id, login, option, note, at, permission) VALUES ('op1', ?, 'maint', 'accept', NULL, 'now', 'write')").run(id);
    await boss.post(dpath(id, "/adopt"), { opinionId: "op1" }, 409);
    await boss.post(dpath(id, "/adopt"), { opinionId: "op1", textsHash: ot.hash }, 409);
    assert.equal((await boss.post<Decision>(dpath(id, "/adopt"), { opinionId: "op1", textsHash: fresh.hash })).answer, "accept");
    await boss.post<Decision>(dpath(id, "/undo"));
    assert.equal((await boss.post<Decision>(dpath(id, "/answer"), { answer: "accept", textsHash: fresh.hash })).answer, "accept");
    db.prepare("INSERT INTO dupe_group_posts (decision_id, number, step, url, at) VALUES (?, 5, 'comment', 'https://x/c', 'now')").run(id);
    await boss.post(dpath(id, "/undo"), undefined, 409);
    db.prepare("UPDATE main.decisions SET applied_at = 'now' WHERE id = ?").run(id);
    db.prepare("DELETE FROM decision_opinions WHERE id = 'op1'").run();
  });

  test("adopt records the operator's answer and credits the opinion; opinions close once answered", async () => {
    const maint = await signedIn("maint");
    const boss = await signedIn("boss");
    const op = (await maint.post<Decision>(dpath(P4, "/feedback"), { option: "plugin", text: `adopt me ${MARKER}` })).opinions.find((o) => o.login === "maint")!;
    const d = await boss.post<Decision>(dpath(P4, "/adopt"), { opinionId: op.id });
    assert.equal(d.answer, "plugin");
    assert.equal(d.answeredBy, "boss");
    assert.equal(d.adoptedOpinion?.id, op.id);
    assert.equal(d.adoptedOpinion?.login, "maint");
    // The group decision test above adopted once as well.
    assert.equal(auditCount("adopt", "boss"), 2);
    await maint.post(dpath(P4, "/feedback"), { option: "small" }, 409);
    await maint.post(dpath(P4, "/retract"), undefined, 409);
  });

  test("a POST without the CSRF header, or from another origin, is refused", async () => {
    const pal = await signedIn("pal");
    const refused: { csrf?: string | null; headers?: Record<string, string> }[] = [
      { csrf: null }, { csrf: "wrong" }, { headers: { origin: "https://evil.example" } }, { headers: { "sec-fetch-site": "cross-site" } },
    ];
    for (const opts of refused) {
      const r = await pal.req("POST", dpath(P1, "/feedback"), { body: { text: "x" }, ...opts });
      assert.equal(r.status, 403, JSON.stringify(opts));
      assert.match(r.headers.get("content-type") ?? "", /application\/json/);
    }
    const same = await pal.req("POST", dpath(P1, "/feedback"), { body: { text: "same origin" }, headers: { origin: base } });
    assert.equal(same.status, 200);
  });

  test("non-operator opinions and comments are limited per login per hour; the operator's are not", async () => {
    const c = await signedIn("chatty");
    for (let i = 0; i < LIMIT; i++) await c.post(dpath(P1, "/feedback"), { text: `n${i}` });
    await c.post(dpath(P1, "/feedback"), { text: "one more" }, 429);
    await c.post(dpath(P1, "/feedback"), { option: "small" }, 429);
    // a second session of the same login shares the limit
    await (await signedIn("chatty")).post(dpath(P1, "/feedback"), { text: "again" }, 429);
    const boss = await signedIn("boss");
    for (let i = 0; i <= LIMIT; i++) await boss.post(dpath(P1, "/feedback"), { text: `b${i}` });
  });

  test("claims show to others and lapse after 10 minutes", async () => {
    const pal = await signedIn("pal");
    const boss = await signedIn("boss");
    await pal.post(dpath(F3, "/claim"), undefined, 204);
    assert.equal((await pal.get<Decision>(dpath(F3))).claim, null, "your own claim isn't shown to you");
    assert.equal((await boss.get<Decision>(dpath(F3))).claim?.login, "pal");
    db.prepare("UPDATE decision_claims SET at = ? WHERE decision_id = ?").run(new Date(Date.now() - 11 * 60_000).toISOString(), F3);
    assert.equal((await boss.get<Decision>(dpath(F3))).claim, null);
  });

  test("opinions and comments never appear in the CLI output agents read", () => {
    // P4 was answered by adopting an opinion whose note carries MARKER.
    const cli = (...args: string[]) => {
      const r = spawnSync(process.execPath, ["src/cli.ts", "decisions", ...args], {
        cwd: new URL("..", import.meta.url), encoding: "utf8", env: { PATH: process.env.PATH, AUTOCRAFT_DB: dbFile },
      });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout;
    };
    db.prepare("UPDATE main.decisions SET answer_note = 'operator-note-text' WHERE id = ?").run(P4);
    const actionable = cli("list", "--actionable").trim().split("\n").map((l) => JSON.parse(l) as { id: string; answer: string });
    assert.deepEqual(actionable.map((a) => [a.id, a.answer]), [[P4, "plugin"]]);
    for (const out of [cli("list", "--actionable"), cli("list", "--all"), cli("show", P4), cli("show", P1)]) {
      assert.doesNotMatch(out, new RegExp(MARKER));
      assert.doesNotMatch(out, /adopt/);
      assert.doesNotMatch(out, /operator-note-text/);
    }
    assert.equal((JSON.parse(cli("show", P4)) as { actionable: boolean }).actionable, true);
  });
});

function getAnswer(id: string): string | null {
  return (db.prepare("SELECT answer FROM main.decisions WHERE id = ?").get(id) as { answer: string | null }).answer;
}
