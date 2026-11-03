// Readable decision and item URLs: how a route is read and which decision a link opens.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { decisionPath, itemPath, parseDecisionRoute, pickDecision } from "../web/src/lib/links.ts";

describe("links", () => {
  test("a route is read by id (old links) or by repo and number", () => {
    const id = "scope:storytold/designcraft#1484:abc";
    assert.deepEqual(parseDecisionRoute({ id: encodeURIComponent(id) }), { by: "id", id });
    assert.deepEqual(parseDecisionRoute({ repo: "designcraft", n: "1484" }), { by: "item", repo: "designcraft", number: 1484 });
    assert.deepEqual(parseDecisionRoute({ repo: "storytold%2Fdesigncraft", n: "7" }), { by: "item", repo: "designcraft", number: 7 });
    assert.deepEqual(parseDecisionRoute({ repo: "designcraft", n: "x" }), { by: "none" });
    assert.deepEqual(parseDecisionRoute({}), { by: "none" });
  });

  test("links are readable except for batches and decisions that share their item", () => {
    const d = { id: "scope:designcraft#5", repo: "designcraft", number: 5 };
    assert.equal(decisionPath(d, { search: "tab=answered" }), "/decisions/designcraft/5?tab=answered");
    assert.equal(decisionPath(d, { sharesItem: true }), `/decisions/${encodeURIComponent(d.id)}`);
    assert.equal(decisionPath({ id: "batch:1", repo: "designcraft", number: null }), "/decisions/batch%3A1");
    assert.equal(itemPath("storytold/designcraft", 5), "/items/designcraft/5");
  });

  test("a readable link opens the first open decision in inbox order, else the latest", () => {
    const mk = (kind: string, askedAt: string, answer: string | null) => ({ kind, askedAt, answer }) as never as Parameters<typeof pickDecision>[0][number];
    const ds = [mk("merge", "2026-01-01", null), mk("scope", "2026-01-03", null), mk("scope", "2026-01-02", null)];
    assert.equal(pickDecision(ds), ds[2]);
    const done = [mk("scope", "2026-01-01", "a"), mk("merge", "2026-01-02", "b")];
    assert.equal(pickDecision(done), done[1]);
    assert.equal(pickDecision([]), undefined);
  });
});
