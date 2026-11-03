// Every item in the dashboard renders through ItemRef or ItemIcon (web/src/ui), so they all look and link the same:
// the icon opens GitHub, the rest opens the item page. This scans the pages for item links built by hand.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

const WEB = new URL("../web/src", import.meta.url).pathname;
// The shared components and the URL builder, and the mock fixtures (data, not UI).
const SKIP = ["ui/", "lib/links.ts", "api/mock/"];

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []));
}

const RULES: { what: string; re: RegExp }[] = [
  { what: "GitHub issue or PR URL", re: /\/(pull|issues)\/\$\{|["'`]\/?(pull|issues)\/?["'`]/ },
  { what: "repo#number text in JSX", re: /\{[\w.]*repo\}#\{[\w.]*\}/ },
];

test("pages render items with ItemRef, not hand-built links", () => {
  const hits: string[] = [];
  for (const f of files(WEB)) {
    const rel = relative(WEB, f);
    if (SKIP.some((s) => rel.startsWith(s))) continue;
    readFileSync(f, "utf8").split("\n").forEach((line, i) => {
      for (const r of RULES) if (r.re.test(line)) hits.push(`${rel}:${i + 1} ${r.what}`);
    });
  }
  assert.deepEqual(hits, []);
});
