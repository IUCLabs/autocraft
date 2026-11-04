// Constants and pure helpers of the merge rule, shared by the old modules (which re-export them) and by decide.ts. No imports.

/** Type labels whose PRs may merge without asking. */
export const RULE_LABELS = ["bugfix", "infra"];
/** Sizes that may merge without asking. */
export const RULE_SIZES = ["S", "M"];
/** Tiers that count as on the whitelist. */
export type Tier = "whitelisted" | "not" | "allow" | "deny";
export const RULE_TIERS: Tier[] = ["whitelisted", "allow"];

/** Why an unsure Opus take is asked about instead of merged by the rule. */
export const UNSURE_REASON = "Opus was unsure";
export const PREMERGE_DEFECT_REASON = "the pre-merge review found a defect";
export const PREMERGE_FAILED_REASON = "the pre-merge review failed";

/** Verification states that let a PR merge. */
export const VERIFY_OK = ["passed", "ci-enough"];
export const verifyOk = (state: string | null | undefined): boolean => !!state && VERIFY_OK.includes(state);
/** A PR in a repo Verify cannot build is merged only on an operator's answer, which says "not verified". */
export const VERIFY_UNAVAILABLE = "unavailable";
export const verifyAllows = (path: "rule" | "operator" | null, state: string | null | undefined): boolean =>
  verifyOk(state) || (path === "operator" && state === VERIFY_UNAVAILABLE);
export const ciAllows = (path: "rule" | "operator" | null, ci: string | null | undefined, noCi: boolean): boolean =>
  ci === "success" || (path === "operator" && ci === "none" && noCi);

export type Size = "S" | "M" | "L";
/** Same S and M bounds as the dashboard's size column; its L and XL are both L here. */
export function sizeOf(linesChanged: number): Size {
  return linesChanged <= 50 ? "S" : linesChanged <= 300 ? "M" : "L";
}

/** Type labels whose PRs get a code review; plugin candidates do not. */
export const REVIEW_LABELS = ["bugfix", "performance", "missing feature", "small extra", "infra"];
/** Scope answers that keep a PR in core (the keys of SCOPE_OPTIONS.take and ["small-extra"]). */
export const KEEP_IN_CORE: string[] = ["take", "small-extra"];

/** Approval attempts per CI run before the PR is left to a person. */
export const MAX_FAILURES = 2;
/** A failed head counts as failed after this many pre-merge tries. */
export const PREMERGE_MAX_TRIES = 3;
/** How long a failed try waits before the next one. */
export const RETRY_AFTER_MS = 3600_000;

/** Queue states a PR leaves for its batch's state while it is in a batch. */
export const BATCHABLE = ["ready", "decision-answered-merge", "refused", "waiting-ci"];
/** States that wait while the repo's main CI is red. */
export const MAIN_RED_HELD = ["ready", "decision-answered-merge", "refused"];

/** The queue's note for a conflicted PR, or null when nothing acts on it. */
export function conflictNote(bucket: string, base: string): string | null {
  switch (bucket) {
    case "merge": return `conflict: merging ${base}`;
    case "ask": case "asked": return "conflict: asked the contributor";
    case "held": return "conflict: held";
    default: return null;
  }
}

/** Fix-up tries per PR (pushed, failed, refused or rejected) before the step leaves it to a person. */
export const FIXUP_MAX_ATTEMPTS = 2;
/** Base branch names a conflict merge accepts. */
export const BASE_NAME = /^[A-Za-z0-9._/-]+$/;

/** CI fix: tries per head, pushed fixes and tries per PR over all heads. */
export const CIFIX_MAX_TRIES = 2;
export const CIFIX_MAX_PUSHES_PER_PR = 2;
export const CIFIX_MAX_TRIES_PER_PR = 4;
export const CIFIX_TRY_STATES = ["formatting", "pushing", "pushed", "failed", "refused", "rejected"];
export const CIFIX_PUSH_STATES = ["pushing", "pushed"];
/** States that end the CI fix step's work at a head. */
export const CIFIX_FINAL_STATES = ["pushed", "pushing", "asked", "push-denied", "cannot-push", "skipped", "comment-failed"];
