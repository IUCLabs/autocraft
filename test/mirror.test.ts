import assert from "node:assert/strict";
import { test } from "node:test";
import { untilCutoff } from "../src/mirror.ts";

const page = (...times: string[]) => times.map((updatedAt) => ({ updatedAt }));

test("incremental sync stops at the first old item and requests no further page", async () => {
  let fetched = 0;
  async function* pages() {
    for (const p of [page("2026-02", "2026-01"), page("2025-12"), page("2025-11")]) {
      fetched++;
      yield p;
    }
  }
  const out: string[][] = [];
  for await (const p of untilCutoff(pages(), "2026-01")) out.push(p.map((n) => n.updatedAt));
  assert.deepEqual(out, [["2026-02", "2026-01"]]);
  assert.equal(fetched, 2);
});

test("no cutoff keeps every page", async () => {
  async function* pages() {
    yield page("a");
    yield page("b");
  }
  let n = 0;
  for await (const _ of untilCutoff(pages(), null)) n++;
  assert.equal(n, 2);
});
