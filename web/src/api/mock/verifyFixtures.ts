// Verify, Fix-up and Act results for the Item page, varied by item number.
import type { Item, ItemAction, ItemFixup, ItemVerification, TaskResult } from "../types";

const H = 3600_000;
const NOW = Date.parse("2026-11-02T10:40:00Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const sha = (n: number) => (n * 7919).toString(16).padStart(8, "0").repeat(5);

const step = (name: string, exitCode: number | null, durationMs: number, timedOut = false): TaskResult => ({ step: name, exitCode, durationMs, timedOut });
const PASS = [step("fetch deps", 0, 6_200), step("build", 0, 192_000), step("test", 0, 18_400)];

function verificationFor(n: number): ItemVerification | null {
  const head = sha(n);
  const base = { headSha: head, baseSha: sha(n + 1), current: true, createdAt: iso(5 * H), finishedAt: iso(4 * H), summary: null, note: null };
  switch (n % 6) {
    case 0:
      return { ...base, kind: "tests", reason: "Touches the PNG decoder only; the codecs tests cover it.", state: "passed", plan: { crates: ["codecs"], tests: ["png::", "decode_"], testLines: null }, tasks: [{ id: 903, role: "head", state: "done", results: PASS, endedAt: iso(4 * H) }] };
    case 1:
      return {
        ...base, kind: "regression", reason: "Bugfix with a reproducible panic; a test can show it fails before the fix.", state: "failed",
        plan: { crates: ["codecs"], tests: [], testLines: 38 },
        summary: "The regression test panics at png.rs:91: the decoded stride is 4096 where 8192 is expected.",
        tasks: [
          { id: 904, role: "head", state: "failed", results: [step("fetch deps", 0, 5_400), step("build", 0, 171_000), step("test", 101, 9_300)], endedAt: iso(4 * H) },
          { id: 905, role: "base", state: "done", results: PASS, endedAt: iso(4 * H) },
        ],
      };
    case 2:
      return { ...base, kind: "ci-enough", reason: "Docs and comments only; CI covers the checks.", state: "ci-enough", plan: null, tasks: [] };
    case 3:
      return { ...base, finishedAt: null, kind: "tests", reason: "Touches the layer compositor; run its crate tests.", state: "running", plan: { crates: ["compositor", "layers"], tests: [], testLines: null }, tasks: [{ id: 906, role: "head", state: "running", results: PASS.slice(0, 2), endedAt: null }] };
    case 4:
      return {
        ...base, kind: "regression", reason: "Fixes a crash on empty selections.", state: "passed", plan: { crates: ["selection"], tests: [], testLines: 24 },
        note: "regression test did not fail on the base commit",
        tasks: [
          { id: 907, role: "head", state: "done", results: PASS, endedAt: iso(4 * H) },
          { id: 908, role: "base", state: "done", results: PASS, endedAt: iso(4 * H) },
        ],
      };
    default:
      return n % 12 === 5 ? { ...base, current: false, kind: "error", reason: "The plan named a crate that is not in the workspace.", state: "error", plan: null, summary: "tasks not queued: unknown crate", tasks: [] } : null;
  }
}

function fixupsFor(n: number): ItemFixup[] {
  if (n % 6 === 1) {
    return [
      { fromHead: sha(n - 1), toHead: null, state: "refused", reason: "the patch touches a file the review did not name", files: ["crates/codecs/src/png.rs"], attempt: 1, createdAt: iso(9 * H) },
      { fromHead: sha(n - 1), toHead: sha(n), state: "pushed", reason: null, files: ["crates/codecs/src/png.rs", "crates/codecs/tests/png16.rs"], attempt: 2, createdAt: iso(7 * H) },
    ];
  }
  if (n % 6 === 4) return [{ fromHead: sha(n), toHead: null, state: "cannot-push", reason: "the contributor has not allowed edits from maintainers", files: [], attempt: 1, createdAt: iso(6 * H) }];
  return [];
}

function actionsFor(n: number, kind: Item["kind"]): ItemAction[] {
  if (n % 6 === 2) return [{ decisionId: `d-${n}`, kind: "comment-close", state: "done", commentUrl: `https://github.com/example-org/repo/pull/${n}#issuecomment-${n * 31}`, reason: null, createdAt: iso(3 * H) }];
  if (kind === "issue" && n % 6 === 0) return [{ decisionId: `d-${n}`, kind: "comment-close", state: "failed", commentUrl: `https://github.com/example-org/repo/issues/${n}#issuecomment-${n * 31}`, reason: "the comment is posted; the close failed (HTTP 502)", createdAt: iso(2 * H) }];
  if (n % 6 === 3 && kind === "pr") return [{ decisionId: `d-${n}`, kind: "comment-close", state: "skipped", commentUrl: null, reason: "the head moved after the decision", createdAt: iso(2 * H) }];
  return [];
}

export function prWorkFor(n: number, kind: Item["kind"]): Pick<Item, "verification" | "fixups" | "actions"> {
  return { verification: kind === "pr" ? verificationFor(n) : null, fixups: kind === "pr" ? fixupsFor(n) : [], actions: actionsFor(n, kind) };
}
