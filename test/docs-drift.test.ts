// The generated blocks of docs/pipeline.md and README.md (scripts/gen-docs.ts) match the stage registry.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { TARGETS, beginMarker, endMarker } from "../scripts/gen-docs.ts";
import { STAGES } from "../src/stages/registry.ts";

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

test("each marker pair appears once and holds the generated block verbatim", () => {
  for (const t of TARGETS) {
    const text = read(t.file);
    for (const [name, make] of Object.entries(t.blocks)) {
      assert.equal(text.split(`<!-- stages:begin ${name} `).length - 1, 1, `${t.file}: begin ${name}`);
      assert.equal(text.split(endMarker(name)).length - 1, 1, `${t.file}: end ${name}`);
      assert.ok(text.includes(`${beginMarker(name)}\n${make()}\n${endMarker(name)}`), `${t.file}: block "${name}" differs; run npm run docs`);
    }
  }
});

test("every docSection heading exists in docs/pipeline.md", () => {
  const headings = new Set(read("docs/pipeline.md").split("\n").filter((l) => l.startsWith("## ")).map((l) => l.slice(3)));
  for (const s of STAGES) assert.ok(headings.has(s.docSection), `${s.id}: ## ${s.docSection}`);
});
