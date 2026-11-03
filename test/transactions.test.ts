// Job processes share one WAL database. A deferred transaction that reads and then writes fails at once with
// "database is locked" when another process committed in between; the busy timeout does not cover that upgrade.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));

test("write transactions take the write lock when they begin", () => {
  const plain = files("src").filter((f) => /exec\(\s*["'`]BEGIN(\s+DEFERRED)?\s*["'`]\s*\)/.test(readFileSync(f, "utf8")));
  assert.deepEqual(plain, [], "use BEGIN IMMEDIATE");
});
