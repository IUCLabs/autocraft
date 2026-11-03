// Every action written to the audit log must be in AUDIT_ACTIONS: maintainers see only listed actions.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { AUDIT_ACTIONS } from "../src/dash/api/admin.ts";

const files = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(d, e.name)) : e.name.endsWith(".ts") ? [join(d, e.name)] : []));
const ARG = String.raw`[^,()"]+,\s*`;
const LIT = String.raw`"([a-z]+(?:-[a-z]+)*)"`;
const patterns = [
  new RegExp(String.raw`\baudit\(\s*${ARG}${ARG}(?:\w+ \? ${LIT} : )?${LIT}`, "g"),
  new RegExp(String.raw`(?<!function )\b(?:ghComment|pushBranch|commentOn|viaGh|begin|recorded)\(\s*(?:${ARG}){1,2}${LIT}`, "g"),
];

test("every audited action is listed in AUDIT_ACTIONS", () => {
  const seen = new Map<string, string>();
  for (const f of files("src")) {
    const text = readFileSync(f, "utf8");
    for (const re of patterns) for (const m of text.matchAll(re)) for (const a of m.slice(1)) if (a) seen.set(a, f);
  }
  assert.ok(seen.size > 60, `found ${seen.size} actions`);
  const missing = [...seen].filter(([a]) => !AUDIT_ACTIONS.includes(a)).map(([a, f]) => `${a} (${f})`);
  assert.deepEqual(missing, []);
});
