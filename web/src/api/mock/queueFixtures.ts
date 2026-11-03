// Fake merge queue: a few PRs in every state, over the mock repos.
import type { QueueBatch, QueueFilter, QueueList, QueueRow, QueueState, TypeLabel } from "../types";
import { AUTHORS, DECISIONS, NOW, REPOS, rng, titleFor } from "./fixtures";

const STATES: QueueState[] = ["ready", "decision-answered-merge", "refused", "waiting-ci", "ci-failed", "conflict", "needs-fix-up", "waiting-opus", "waiting-verify", "verify-failed", "verify-error", "needs-decision", "declined", "merged"];
const REASONS = [
  "Fixes the off-by-one in the page range and adds a test.",
  "Small, correct guard against an empty selection.",
  "Restores the reference app's default margin.",
  "CI config change; runs the same jobs faster.",
  "Correct, but the error message should name the file.",
];
const LABELS: TypeLabel[] = ["bugfix", "infra", "missing feature", "performance"];

function verifyFor(state: QueueState, i: number): QueueRow["verify"] {
  switch (state) {
    case "ready": case "decision-answered-merge": case "refused": case "needs-decision":
      return i % 2 ? { state: "ci-enough", kind: "ci-enough", summary: "Docs and comments only; CI covers the checks.", note: null } : { state: "passed", kind: i % 3 ? "tests" : "regression", summary: null, note: i === 2 ? "regression test did not fail on the base commit" : null };
    case "waiting-verify": return i % 2 ? { state: "running", kind: "tests", summary: null, note: null } : { state: "planned", kind: "regression", summary: null, note: null };
    case "verify-failed": return { state: "failed", kind: "regression", summary: "The regression test panics at png.rs:91: the decoded stride is 4096 where 8192 is expected.", note: null };
    case "verify-error": return { state: "error", kind: "tests", summary: "fetch deps failed (exit 101)", note: null };
    default: return null;
  }
}

const ROWS: QueueRow[] = (() => {
  const r = rng(606);
  const mergeDecision = DECISIONS.find((d) => d.kind === "merge")?.id ?? null;
  const out: QueueRow[] = [];
  let k = 0;
  for (const state of STATES) {
    const n = state === "ready" || state === "waiting-verify" || state === "needs-decision" || state === "waiting-ci" ? 4 : 2;
    for (let i = 0; i < n; i++, k++) {
      const repo = REPOS[k % 6]!;
      const number = 200 + Math.floor(r() * 3000);
      const [author, tier] = AUTHORS[k % AUTHORS.length]!;
      const ruleTier = tier === "whitelisted" || tier === "override-allow";
      const rulePath = state === "ready" || ((state === "waiting-ci" || state === "refused") && i % 2 === 0);
      const label = rulePath ? (i % 2 ? "infra" : "bugfix") : LABELS[k % LABELS.length]!;
      const size = rulePath ? (i % 2 ? "M" : "S") : (["S", "M", "L"] as const)[k % 3];
      const outsideRule = rulePath ? [] : [
        ...(state === "needs-fix-up" ? ["review asks for fixes"] : []),
        ...(size === "L" ? ["size L"] : []),
        ...(label !== "bugfix" && label !== "infra" ? [`label ${label}`] : []),
        ...(ruleTier ? [] : ["author not on the whitelist"]),
      ];
      if (!rulePath && !outsideRule.length) outsideRule.push("author not on the whitelist");
      const ci: QueueRow["ci"] = state === "ci-failed" ? "failure" : state === "waiting-ci" ? "pending" : state === "needs-decision" && i === 3 ? "pending" : "success";
      out.push({
        repo, number, title: titleFor(repo, number), author, tier: rulePath ? "whitelisted" : tier, head: `${(number * 2654435761 >>> 0).toString(16).padStart(8, "0")}c0ffee12345678900abcdef1234`,
        size, label, verdict: state === "needs-fix-up" ? "take-fix" : "take", reason: REASONS[k % REASONS.length]!,
        fixes: state === "needs-fix-up" ? 1 + (i % 3) : 0, ci, mergeable: state === "conflict" ? "conflicts" : "clean", state,
        path: rulePath ? "rule" : state === "decision-answered-merge" || state === "refused" ? "operator" : null,
        outsideRule, decisionId: state === "needs-decision" || state === "decision-answered-merge" || state === "declined" ? mergeDecision : null,
        answer: state === "decision-answered-merge" ? "merge" : state === "declined" ? (i ? "close" : "hold") : null,
        refusedReason: state === "refused" ? "safe-merge: required check 'build (linux)' has not finished" : null,
        reviewedAt: new Date(NOW - (k + 1) * 3_600_000 * 5).toISOString(),
        verify: verifyFor(state, i),
      });
    }
  }
  return out.sort((a, b) => a.repo.localeCompare(b.repo) || a.number - b.number);
})();

const BATCHES: QueueBatch[] = [
  { id: 3, repo: "photocraft", branch: "integration-photocraft-20261103-2", state: "open", prs: [{ number: 412, head: "a1b2c3d" }, { number: 418, head: "e4f5a6b" }, { number: 421, head: "c7d8e9f" }], prNumber: 430, prUrl: "https://github.com/storytold/photocraft/pull/430", summary: null, createdAt: "2026-11-03T08:10:00Z", updatedAt: "2026-11-03T08:40:00Z" },
  { id: 2, repo: "photocraft", branch: "integration-photocraft-20261103-1", state: "split", prs: [{ number: 405, head: "1a2b3c4" }, { number: 407, head: "5d6e7f8" }], prNumber: 428, prUrl: "https://github.com/storytold/photocraft/pull/428", summary: "upstream CI failed on the batch PR", createdAt: "2026-11-03T06:00:00Z", updatedAt: "2026-11-03T07:30:00Z" },
  { id: 1, repo: "designcraft", branch: "integration-designcraft-20261102-1", state: "merged", prs: [{ number: 88, head: "9a8b7c6" }], prNumber: 91, prUrl: "https://github.com/storytold/designcraft/pull/91", summary: null, createdAt: "2026-11-02T12:00:00Z", updatedAt: "2026-11-02T13:00:00Z" },
];

export function queueList(f: QueueFilter): QueueList {
  const all = ROWS.filter((x) => !f.repo || x.repo === f.repo);
  const counts = Object.fromEntries(STATES.map((s) => [s, all.filter((x) => x.state === s).length])) as Record<QueueState, number>;
  const match = all.filter((x) => (f.state ? x.state === f.state : x.state !== "merged"));
  const from = f.after ? match.findIndex((x) => `${x.repo}#${x.number}` === f.after) + 1 : 0;
  const rows = match.slice(from, from + (f.limit ?? 100));
  const last = rows[rows.length - 1];
  return { rows, counts, total: match.length, batches: BATCHES.filter((b) => !f.repo || b.repo === f.repo), next: last && from + rows.length < match.length ? `${last.repo}#${last.number}` : null };
}
