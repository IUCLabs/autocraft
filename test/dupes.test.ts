// Duplicates stage: pair generation, model routing, canonical rule, decisions,
// the act step's close, and the hold on later stages. No model or GitHub calls.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";
import { setCommentApproval } from "../src/act/approval.ts";
import { runAct, type ActDeps } from "../src/act/index.ts";
import { duplicateComment } from "../src/act/templates.ts";
import { connect } from "../src/db.ts";
import { selectCandidates as decideCandidates } from "../src/decide/select.ts";
import { checkPairs, type CheckDeps } from "../src/dupes/check.ts";
import { runDupeCompare } from "../src/dupes/compare.ts";
import { applyDuplicateAnswers, askDuplicateDecisions } from "../src/dupes/decide.ts";
import { ask as askDecision } from "../src/decisions.ts";
import { duplicateCount, duplicateHeld } from "../src/dupes/held.ts";
import { dupesWork, runDupes, type DupesDeps } from "../src/dupes/index.ts";
import { pickCanonical } from "../src/dupes/canonical.ts";
import { settlePair } from "../src/dupes/pair.ts";
import { MAX_NEIGHBOURS, neighbourPairs, scanPending, type ScanItem } from "../src/dupes/scan.ts";
import type { Embedder } from "../src/embed/model.ts";
import { VectorIndex } from "../src/embed/vectors.ts";
import type { Querier } from "../src/mirror.ts";
import { selectCandidates as reviewCandidates } from "../src/review/candidates.ts";
import { SCRATCH } from "./scratch.ts";
import { validating } from "./gql.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "dupes-test-"));
const NOW = new Date("2026-06-01T00:00:00Z");
const T0 = "2026-01-01T00:00:00Z";
const MODEL = "test-model";
const embedder: Embedder = { id: MODEL, dim: 4, embed: async () => [] };
const blob = (v: number[]) => new Uint8Array(new Float32Array(v).buffer);
/** A unit vector at cosine `c` from the axis [1,0,0,0]. */
const at = (c: number) => [c, Math.sqrt(1 - c * c), 0, 0];

type Spec = { n: number; kind?: "issue" | "pr"; state?: string; sim: number; repo?: string; closedAt?: string; closing?: number[]; created?: string; comments?: number; title?: string; hash?: string };
function fresh(specs: Spec[]): { db: DatabaseSync; index: VectorIndex } {
  const db = connect(join(mkdtempSync(join(dir, "db-")), "t.db"));
  db.prepare("INSERT OR IGNORE INTO tracked_repos (name, added_by, added_at, pipeline) VALUES ('app', 'op', ?, 1)").run(T0);
  db.prepare("INSERT OR IGNORE INTO tracked_repos (name, added_by, added_at, pipeline) VALUES ('other', 'op', ?, 1)").run(T0);
  db.prepare("INSERT INTO access (login, role) VALUES ('op', 'operator'), ('helper', 'maintainer')").run();
  const item = db.prepare(`INSERT INTO items (repo, number, kind, state, title, body, created_at, updated_at, closed_at, merged_at, closing_issues, comments_count, embed_hash, head_oid)
    VALUES (?, ?, ?, ?, ?, 'body', ?, ?, ?, ?, ?, ?, ?, ?)`);
  const emb = db.prepare("INSERT INTO item_embeddings (repo, number, model, hash, vec, at) VALUES (?, ?, ?, ?, ?, ?)");
  for (const s of specs) {
    const repo = s.repo ?? "app", state = s.state ?? "OPEN", hash = s.hash ?? `h${s.n}`;
    item.run(repo, s.n, s.kind ?? "issue", state, s.title ?? `Item ${s.n}`, s.created ?? T0, T0, state === "OPEN" ? null : (s.closedAt ?? "2026-03-01T00:00:00Z"),
      state === "MERGED" ? (s.closedAt ?? "2026-03-01T00:00:00Z") : null, s.closing ? JSON.stringify(s.closing) : null, s.comments ?? 0, hash, s.kind === "pr" ? `sha${s.n}` : null);
    // Item 1 is the query axis; the others sit at their similarity to it.
    emb.run(repo, s.n, MODEL, hash, blob(s.n === 1 && !s.repo ? [1, 0, 0, 0] : at(s.sim)), T0);
  }
  return { db, index: new VectorIndex(embedder) };
}
const scanItem1 = async (db: DatabaseSync, index: VectorIndex, n = 1) => {
  await index.ready(db);
  const it = db.prepare("SELECT repo, number, kind, state, embed_hash, closed_at, merged_at, closing_issues FROM items WHERE repo = 'app' AND number = ?").get(n) as ScanItem;
  return neighbourPairs(db, index, it, NOW.getTime());
};
const nums = (ps: { a: number; b: number }[]) => ps.map((p) => (p.a === 1 ? p.b : p.a)).sort((x, y) => x - y);

describe("candidate pairs", () => {
  test("leaves out the item itself, linked PRs, other kinds, other repos, old closed items and low similarity", async () => {
    const { db, index } = fresh([
      { n: 1, sim: 1 }, { n: 2, sim: 0.97 }, { n: 3, sim: 0.3 },
      { n: 10, kind: "pr", sim: 1, closing: [1] },            // closes issue 1: linked
      { n: 11, kind: "pr", sim: 0.99 },                       // a PR is not compared with an issue
      { n: 4, state: "CLOSED", sim: 0.95, closedAt: "2026-04-01T00:00:00Z" }, // closed recently: kept
      { n: 5, state: "CLOSED", sim: 0.95, closedAt: "2024-01-01T00:00:00Z" }, // closed long ago
      { n: 2, repo: "other", sim: 0.99 },
    ]);
    assert.deepEqual(nums(await scanItem1(db, index)), [2, 4]);
  });

  test("two PRs are compared, but not a PR with the issue it closes", async () => {
    const { db, index } = fresh([{ n: 1, kind: "pr", sim: 1 }, { n: 2, kind: "pr", sim: 0.95 }, { n: 3, kind: "issue", sim: 1, closing: undefined }]);
    db.prepare("UPDATE items SET closing_issues = '[3]' WHERE number = 1").run();
    assert.deepEqual(nums(await scanItem1(db, index)), [2]);
  });

  test("keeps at most MAX_NEIGHBOURS best neighbours above the threshold", async () => {
    const specs: Spec[] = [{ n: 1, sim: 1 }];
    for (let k = 0; k < 6; k++) specs.push({ n: 2 + k, sim: 0.99 - k * 0.02 });
    const { db, index } = fresh(specs);
    const ps = await scanItem1(db, index);
    assert.equal(ps.length, MAX_NEIGHBOURS);
    assert.deepEqual(nums(ps), [2, 3, 4]);
    assert.ok(ps.every((p) => p.similarity >= 0.86));
  });

  test("an item is scanned once per text hash, and a changed text scans again", async () => {
    const { db, index } = fresh([{ n: 1, sim: 1 }, { n: 2, sim: 0.97 }]);
    const deps = (): DupesDeps => ({ index, check: { jev: async () => 0.5, haiku: async () => null, now: () => NOW } });
    await runDupes(db, { limit: 0 }, () => {}, deps());
    assert.equal(scanPending(db, MODEL).length, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM duplicate_pairs").get() as { n: number }).n, 1);
    await runDupes(db, { limit: 0 }, () => {}, deps());
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM duplicate_pairs").get() as { n: number }).n, 1);
    db.prepare("UPDATE items SET embed_hash = 'h2b' WHERE number = 2").run();
    db.prepare("UPDATE item_embeddings SET hash = 'h2b' WHERE number = 2").run();
    assert.equal(scanPending(db, MODEL).length, 1);
  });
});

describe("pair check routing", () => {
  const pairs = [[1, 2], [1, 3], [1, 4], [1, 5], [1, 6]];
  function run(jev: Record<string, number | null>, haiku: Record<string, string>) {
    const { db } = fresh([1, 2, 3, 4, 5, 6].map((n) => ({ n, sim: 0.95 })));
    for (const [a, b] of pairs) db.prepare("INSERT INTO duplicate_pairs (repo, a, b, a_hash, b_hash, similarity, created_at) VALUES ('app', ?, ?, ?, ?, 0.95, ?)").run(a, b, `h${a}`, `h${b}`, T0);
    const asked: string[][] = [];
    const deps: CheckDeps = {
      jev: async (p) => jev[p.ref] ?? null,
      haiku: async (ps) => { asked.push(ps.map((p) => p.ref)); return JSON.stringify(ps.map((p) => ({ ref: p.ref, verdict: haiku[p.ref] ?? "unsure", reason: "r" }))); },
      now: () => NOW,
    };
    return { db, asked, deps };
  }
  test("Jev decides at 0.9 either way; Haiku gets the rest", async () => {
    const { db, asked, deps } = run(
      { "app#1~2": 0.95, "app#1~3": 0.04, "app#1~4": 0.6, "app#1~5": 0.3, "app#1~6": null },
      { "app#1~4": "duplicate", "app#1~5": "duplicate", "app#1~6": "distinct" });
    const keys = db.prepare("SELECT repo, a, b, a_hash, b_hash, similarity FROM duplicate_pairs").all() as never[];
    const c = await checkPairs(db, keys, deps);
    assert.deepEqual(asked.flat().sort(), ["app#1~4", "app#1~5", "app#1~6"]);
    const v = Object.fromEntries((db.prepare("SELECT b, verdict, haiku, jev_p, canonical FROM duplicate_pairs").all() as { b: number; verdict: string; haiku: string | null; jev_p: number | null; canonical: number | null }[]).map((r) => [r.b, r]));
    assert.equal(v[2]!.verdict, "duplicate");
    assert.equal(v[2]!.haiku, null);
    assert.equal(v[2]!.canonical, 1);
    assert.equal(v[3]!.verdict, "distinct");
    assert.equal(v[4]!.verdict, "duplicate");
    assert.equal(v[5]!.verdict, "unsure");   // Haiku says duplicate but Jev is at 0.3
    assert.equal(v[6]!.verdict, "distinct");
    assert.equal(c.checked, 5);
  });
  test("settlePair", () => {
    assert.equal(settlePair(0.9, null), "duplicate");
    assert.equal(settlePair(0.1, null), "distinct");
    assert.equal(settlePair(0.5, null), null);
    assert.equal(settlePair(0.5, "unsure"), "unsure");
  });
});

describe("canonical", () => {
  test("closed first, then a merged fix, then much more discussion, then the older", () => {
    const { db } = fresh([
      { n: 1, sim: 1, created: "2026-02-01T00:00:00Z" }, { n: 2, sim: 1, created: "2026-01-01T00:00:00Z" },
      { n: 3, sim: 1, state: "CLOSED", created: "2026-03-01T00:00:00Z" },
      { n: 4, sim: 1, created: "2026-03-01T00:00:00Z", comments: 6 }, { n: 5, sim: 1, created: "2026-01-01T00:00:00Z", comments: 1 },
      { n: 6, kind: "pr", sim: 1, state: "MERGED", closing: [8] }, { n: 7, sim: 1, created: "2026-01-01T00:00:00Z" }, { n: 8, sim: 1, created: "2026-04-01T00:00:00Z" },
    ]);
    assert.equal(pickCanonical(db, "app", [1, 2]).number, 2);        // older
    assert.equal(pickCanonical(db, "app", [2, 3]).number, 3);        // closed
    assert.equal(pickCanonical(db, "app", [4, 5]).number, 4);        // 5 more comments
    assert.equal(pickCanonical(db, "app", [7, 8]).number, 8);        // a merged PR fixes 8
  });
});

function withDuplicates(): { db: DatabaseSync } {
  // 1 is the oldest; 2 and 3 are duplicates of it; 4 is a pair of its own.
  const { db } = fresh([
    { n: 1, sim: 1, created: "2026-01-01T00:00:00Z", title: "Crash on TIFF" }, { n: 2, sim: 1, created: "2026-02-01T00:00:00Z", title: "TIFF crash" },
    { n: 3, sim: 1, created: "2026-03-01T00:00:00Z", title: "Quits on tiff" }, { n: 4, sim: 1, created: "2026-04-01T00:00:00Z" }, { n: 5, sim: 1, created: "2026-05-01T00:00:00Z" },
  ]);
  const put = db.prepare("INSERT INTO duplicate_pairs (repo, a, b, a_hash, b_hash, similarity, jev_p, verdict, canonical, checked_at, created_at) VALUES ('app', ?, ?, ?, ?, 0.93, 0.95, 'duplicate', ?, ?, ?)");
  for (const [a, b] of [[1, 2], [2, 3], [4, 5]]) put.run(a, b, `h${a}`, `h${b}`, a, T0, T0);
  return { db };
}
/** Pair decisions as asked before groups existed; answered ones still take effect. */
function legacyPairDecisions(db: DatabaseSync): string[] {
  const ids: string[] = [];
  for (const [x, y] of [[2, 1], [3, 1], [5, 4]] as const) {
    const id = `app#${x}:duplicate@${y}`;
    askDecision(db, [{ id, kind: "duplicate", repo: "app", number: x, question: `Close #${x} as a duplicate of #${y}?`, facts: [`duplicate of app#${y}`],
      options: [{ key: "close", label: "Close as duplicate" }, { key: "distinct", label: "Not a duplicate" }, { key: "keep", label: "Keep both" }], asked_at: T0 }]);
    ids.push(id);
  }
  return ids;
}
/** Compares every group with a model that gives no answer, so the rule decides. */
const compareByRule = (db: DatabaseSync) => runDupeCompare(db, {}, () => {}, { fetchDiff: async () => ({ ok: false, tooLarge: false, error: "x" }), ask: (async () => null) as never, now: () => NOW });
const getGroupCloses = (db: DatabaseSync, id: string): number[] => (db.prepare("SELECT number FROM dupe_group_items WHERE decision_id = ? AND role = 'close'").all(id) as { number: number }[]).map((r) => r.number);
const answer = (db: DatabaseSync, id: string, by: string, key: string) => db.prepare("UPDATE decisions SET answer = ?, answered_by = ?, answered_at = ? WHERE id = ?").run(key, by, T0, id);

describe("decisions", () => {
  test("nothing is asked before a group is compared; then one decision per group, and asking again adds none", async () => {
    const { db } = withDuplicates();
    assert.deepEqual(askDuplicateDecisions(db, undefined, T0), []);
    await compareByRule(db);
    assert.deepEqual(askDuplicateDecisions(db, undefined, T0).sort(), ["app:dupegroup:1", "app:dupegroup:4"]);
    const d = db.prepare("SELECT * FROM decisions WHERE id = 'app:dupegroup:1'").get() as { question: string; options: string; kind: string; number: number };
    assert.equal(d.question, "Keep #1 and close #2, #3 as duplicates?");
    assert.deepEqual([d.kind, d.number], ["duplicate", 1]);
    assert.deepEqual((JSON.parse(d.options) as { key: string }[]).map((o) => o.key), ["accept", "keep:2", "keep:3", "distinct"]);
    askDuplicateDecisions(db, undefined, T0);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM decisions").get() as { n: number }).n, 2);
    assert.equal(duplicateCount(db, "app", 1), 2);
  });

  test("Not a duplicate on a pair decision is stored as distinct and never asked again, even after the text changes", async () => {
    const { db } = withDuplicates();
    legacyPairDecisions(db);
    answer(db, "app#5:duplicate@4", "op", "distinct");
    assert.equal(applyDuplicateAnswers(db, T0), 1);
    const p = db.prepare("SELECT verdict, by_operator FROM duplicate_pairs WHERE a = 4 AND b = 5").get() as { verdict: string; by_operator: number };
    assert.deepEqual({ ...p }, { verdict: "distinct", by_operator: 1 });
    await compareByRule(db);
    assert.ok(!askDuplicateDecisions(db, undefined, T0).includes("app:dupegroup:4"));
    assert.equal(applyDuplicateAnswers(db, T0), 0);
    assert.equal(duplicateHeld(db, "app", 5), false);
  });
});

describe("hold on later stages", () => {
  function build(label: string, flags: string): DatabaseSync {
    const db = connect(join(mkdtempSync(join(dir, "db-")), "h.db"));
    db.exec("INSERT OR IGNORE INTO tracked_repos (name, pipeline) VALUES ('app', 1); UPDATE tracked_repos SET pipeline = 1");
    const item = db.prepare(`INSERT INTO items (repo, number, kind, state, title, body, created_at, updated_at, head_oid, additions, deletions, changed_files)
      VALUES ('photocraft', ?, ?, 'OPEN', 't', 'b', ?, ?, ?, 5, 1, 1)`);
    const cls = db.prepare(`INSERT INTO classifications (repo, number, classifier, run_id, at, type_label, flags, probs) VALUES ('photocraft', ?, 'jev', 'r1', ?, ?, ?, '{"top":0.95}')`);
    for (const [n, kind] of [[1, "issue"], [2, "pr"], [3, "pr"]] as const) { item.run(n, kind, T0, T0, kind === "pr" ? `sha${n}` : null); cls.run(n, T0, label, flags); }
    return db;
  }
  const ask = (db: DatabaseSync, n: number) =>
    db.prepare("INSERT INTO decisions (id, kind, repo, number, question, options, asked_at) VALUES (?, 'duplicate', 'photocraft', ?, 'q', '[]', ?)").run(`photocraft#${n}:duplicate@9`, n, T0);

  test("a held item leaves the Decide candidates until released", () => {
    const db = build("missing feature", '["needs decision"]');
    const ids = () => decideCandidates(db, "r1", ["photocraft"]).map((c) => c.number).sort();
    assert.deepEqual(ids(), [1, 2, 3]);
    ask(db, 1); ask(db, 2);
    assert.deepEqual(ids(), [3]);
    answer(db, "photocraft#2:duplicate@9", "op", "close");   // held until the close happens
    assert.deepEqual(ids(), [3]);
    answer(db, "photocraft#2:duplicate@9", "op", "keep");
    answer(db, "photocraft#1:duplicate@9", "op", "distinct");
    assert.deepEqual(ids(), [1, 2, 3]);
  });

  test("a held PR leaves the Review candidates until released", () => {
    const db = build("bugfix", "[]");
    const prs = () => reviewCandidates(db, "photocraft", "r1").map((c) => c.number).sort();
    assert.deepEqual(prs(), [2, 3]);
    ask(db, 2);
    assert.deepEqual(prs(), [3]);
    answer(db, "photocraft#2:duplicate@9", "op", "keep");
    assert.deepEqual(prs(), [2, 3]);
  });
});

describe("act on close as duplicate", () => {
  const deps = (log: string[], closedOriginal = false): ActDeps => {
    const querier: Querier = validating({
      spent: 0, remaining: 5000,
      async query(query: string, vars: object) {
        const v = vars as { n?: number; id?: string; body?: string };
        if (query.startsWith("mutation") && query.includes("addComment")) { log.push(`comment ${v.id}: ${v.body}`); return { addComment: { commentEdge: { node: { url: "https://x/c" } } } }; }
        if (query.startsWith("mutation")) { log.push(`close ${v.id}`); return {}; }
        const state = v.n === 1 && closedOriginal ? "CLOSED" : "OPEN";
        return { repository: { issueOrPullRequest: { __typename: "Issue", id: `I${v.n}`, state } } };
      },
    });
    return { querier, now: () => NOW };
  };
  const go = (db: DatabaseSync, d: ActDeps) => runAct(db, { repo: "app", dryRun: false }, () => {}, d);

  test("posts the duplicate comment and closes, only for an operator's answer in an approved repo", async () => {
    const { db } = withDuplicates();
    legacyPairDecisions(db);
    answer(db, "app#2:duplicate@1", "helper", "close");
    answer(db, "app#3:duplicate@1", "op", "close");
    const log: string[] = [];
    await go(db, deps(log));                      // not approved
    assert.deepEqual(log, []);
    setCommentApproval(db, "op", "app", true);
    await go(db, deps(log));
    assert.deepEqual(log, ["comment I3: Duplicate of #1.", "close I3"]);
    await go(db, deps(log));
    assert.equal(log.length, 2);                  // done once
  });

  test("names a closed original", async () => {
    const { db } = withDuplicates();
    legacyPairDecisions(db);
    answer(db, "app#2:duplicate@1", "op", "close");
    setCommentApproval(db, "op", "app", true);
    const log: string[] = [];
    await go(db, deps(log, true));
    assert.equal(log[0], "comment I2: Duplicate of #1, which is closed.");
    assert.equal(duplicateComment({ repo: "app", original: "app#1", closed: true }), "Duplicate of #1, which is closed.");
    assert.equal(duplicateComment({ repo: "app", original: "lib#7", closed: false }), "Duplicate of storytold/lib#7.");
  });

  test("a not-a-duplicate answer writes nothing and releases the pair even without comment approval", async () => {
    const { db } = withDuplicates();
    legacyPairDecisions(db);
    answer(db, "app#2:duplicate@1", "op", "distinct");
    const log: string[] = [];
    await go(db, deps(log));
    assert.deepEqual(log, []);
    assert.equal((db.prepare("SELECT verdict FROM duplicate_pairs WHERE a = 1 AND b = 2").get() as { verdict: string }).verdict, "distinct");
    await compareByRule(db);
    assert.ok(!askDuplicateDecisions(db, undefined, T0).some((id) => id.startsWith("app:dupegroup:1") && getGroupCloses(db, id).includes(2)));
  });
});

describe("dupesWork", () => {
  test("is false until a group is compared, true while a compared group's decision is unasked, false once asked", async () => {
    const { db } = withDuplicates();
    assert.equal(dupesWork(db, "no-embeddings"), false);
    await compareByRule(db);                      // asks the decisions too
    assert.equal(dupesWork(db, "no-embeddings"), false);
    db.prepare("DELETE FROM decisions").run();
    assert.equal(dupesWork(db, "no-embeddings"), true);
    askDuplicateDecisions(db, undefined, T0);
    assert.equal(dupesWork(db, "no-embeddings"), false);
  });
});
