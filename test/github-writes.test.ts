// Every write to GitHub goes through src/github/write.ts, which records it. This scans the rest of src/ for
// the ways a write can be sent and fails on any hit, so a new write path cannot skip the activity record.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { GITHUB_ACTIONS } from "../src/github/write.ts";

const SRC = new URL("../src", import.meta.url).pathname;
const WRITER = "github/write.ts";

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));
}

const RULES: { what: string; re: RegExp; window?: number }[] = [
  { what: "GraphQL mutation", re: /["'`]\s*mutation\b/ },
  { what: "git push", re: /["'`]push["'`]/ },
  { what: "gh pr/issue write", re: /["'`](pr|issue)["'`]\s*,\s*["'`](merge|create|close|comment|edit|ready|reopen|delete|lock|review|transfer|pin|unpin|unlock)["'`]/ },
  { what: "gh workflow/run/secret write", re: /["'`](workflow|run|secret|variable)["'`]\s*,\s*["'`](run|rerun|cancel|enable|disable|set|delete|remove)["'`]/ },
  { what: "gh repo/label/release write", re: /["'`](repo|label|release|gist)["'`]\s*,\s*["'`](fork|create|edit|delete|rename|archive|clone)["'`]/ },
  { what: "gh api write verb", re: /["'`]api["'`][^\n]*["'`](--method|-X|--field|-f|-F|--raw-field)["'`]/, window: 3 },
  { what: "HTTP write verb", re: /method:\s*["'`](POST|PATCH|PUT|DELETE)["'`]/ },
  { what: "merge command run", re: /\.run\(\s*\w+\.mergeCommand/ },
  { what: "safe-merge started", re: /["'`]safe-merge["'`]\s*,\s*\.\.\./ },
];

// Files that match a rule without writing to GitHub.
const ALLOWED: Record<string, string[]> = {
  "dash/api/index.ts": ["HTTP write verb"], // this app's own routes
  "dash/server/provider.ts": ["HTTP write verb"], // OAuth token exchange for sign-in
  "merge/safe-merge.ts": ["gh api write verb"], // -f/-F only pass variables to a read-only GraphQL query
  "merge/index.ts": ["safe-merge started"], // starts the built-in command; the write is recorded by mergeViaCommand
};

test("only src/github/write.ts sends writes to GitHub", () => {
  const hits: string[] = [];
  for (const f of files(SRC)) {
    const rel = relative(SRC, f);
    if (rel === WRITER) continue;
    const lines = readFileSync(f, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      for (const r of RULES) {
        // A rule with a window also matches a call written over a few lines.
        const text = r.window ? lines.slice(i, i + r.window).join(" ") : line;
        if (r.window && !/["'`]api["'`]/.test(line)) continue;
        if (r.re.test(text) && !(ALLOWED[rel] ?? []).includes(r.what)) hits.push(`${rel}:${i + 1}: ${r.what}: ${line.trim().slice(0, 100)}`);
      }
    });
  }
  assert.deepEqual(hits, [], "write through src/github/write.ts so the activity is recorded");
});

test("the write module has a label for every action it records", () => {
  const src = readFileSync(join(SRC, WRITER), "utf8");
  const used = new Set([...src.matchAll(/(?:"|')([a-z]+(?:-[a-z]+)*)(?:"|')/g)].map((m) => m[1]!).filter((a) => /^(labels-apply|label-create|act-|fixup-|fixissue-|batch-|review-|merge$|assign$|unassign$|fork-create)/.test(a)));
  for (const a of used) assert.ok(a in GITHUB_ACTIONS, `${a} has no label in GITHUB_ACTIONS`);
});
