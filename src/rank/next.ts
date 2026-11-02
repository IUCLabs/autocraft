// The next pipeline step of an open item, for the Work queue page. Reads local tables only.
import type { DatabaseSync } from "node:sqlite";

export type NextFacts = {
  kind: "pr" | "issue";
  label: string | null;
  settled: boolean;
  scopeOpen: boolean;
  needsDecision: boolean;
  /** Latest review verdict at the PR's current head, if any. */
  review: string | null;
  /** Verification state at the PR's current head, if any. */
  verify: string | null;
  /** Fix attempt state of an issue, if any. */
  attempt: string | null;
};

export function nextStepOf(f: NextFacts): string {
  if (!f.settled) return "Classify";
  if (f.scopeOpen) return "Decide: waiting for a scope answer";
  if (f.kind === "issue") {
    switch (f.attempt) {
      case "retry": case "testing": return "Fix: in progress";
      case "passed": case "pr-opened": return "Fix: pull request opened";
      case "skipped": case "failed": return "Needs a person";
      default: return f.label === "bugfix" && !f.needsDecision ? "Fix" : f.needsDecision ? "Decide" : "Triage by a person";
    }
  }
  if (f.needsDecision && !f.review) return "Decide";
  switch (f.review) {
    case null: return "Review";
    case "take-fix": return "Fix-up";
    case "hold": return "Needs a person";
    case "close": return "Close";
    default:
      if (f.verify === "passed" || f.verify === "ci-enough") return "Merge queue";
      if (f.verify === "failed" || f.verify === "error") return "Needs a person: verification failed";
      return f.verify ? "Verify: running" : "Verify";
  }
}

/** Facts of one item from the stored tables. */
export function factsOf(db: DatabaseSync, repo: string, number: number, kind: string, head: string | null, label: string | null, settled: boolean, flags: string[]): NextFacts {
  const review = kind === "pr" ? (db.prepare("SELECT verdict, head_oid FROM reviews WHERE repo = ? AND number = ? ORDER BY at DESC, rowid DESC LIMIT 1").get(repo, number) as { verdict: string; head_oid: string } | undefined) : undefined;
  const verify = kind === "pr" && head ? (db.prepare("SELECT state FROM verifications WHERE repo = ? AND number = ? AND head_sha = ?").get(repo, number, head) as { state: string } | undefined) : undefined;
  const attempt = kind === "issue" ? (db.prepare("SELECT state FROM fix_attempts WHERE repo = ? AND number = ?").get(repo, number) as { state: string } | undefined) : undefined;
  const scope = db.prepare("SELECT answer FROM decisions WHERE kind = 'scope' AND repo = ? AND number = ? ORDER BY asked_at DESC LIMIT 1").get(repo, number) as { answer: string | null } | undefined;
  return {
    kind: kind === "pr" ? "pr" : "issue", label, settled, scopeOpen: !!scope && scope.answer === null, needsDecision: flags.includes("needs decision"),
    review: review && review.head_oid === head ? review.verdict : null, verify: verify?.state ?? null, attempt: attempt?.state ?? null,
  };
}
