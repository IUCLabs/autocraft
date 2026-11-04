// The guard: the only way to get a `Guarded` value, which every PR write in github/write.ts requires.
// Right before a write it reloads the facts (with a live read of head, state and mergeable for merges and pushes),
// runs decide() again, applies the gates, and passes only when the Plan still holds the same action at the same head.
import type { DatabaseSync } from "node:sqlite";
import type { Querier } from "../mirror.ts";
import { refreshChecks } from "../review/checks.ts";
import { decidePr } from "./decide.ts";
import { loadPrFact } from "./facts.ts";
import { commentApprovalOf } from "../act/approval.ts";
import { fixIssueApprovalOf } from "../fixissue/approval.ts";
import { pushApprovalOf } from "../fixup/approval.ts";
import { approvalOf as labelsApprovalOf } from "../labels/approval.ts";
import { mainFixApprovalOf } from "../mainfix/approval.ts";
import { mergeApprovalOf } from "../merge/approval.ts";
import { ciApprovalOf } from "../merge/ci-approval.ts";
import { decideItem } from "./decide-item.ts";
import { gateRepo, gates, type Approval, type By, type Want } from "./gates.ts";
import { loadItemFact } from "./issue-facts.ts";
import type { PrFacts } from "./plan.ts";

declare const guarded: unique symbol;

/** What the guard let through: the action, the reviewed head it holds at, and the PR. Only `guard` makes one. */
export type Guarded = { readonly [guarded]: true; readonly scope: "pr"; readonly action: Want; readonly head: string; readonly repo: string; readonly number: number };
/** What the guard let through for an issue or PR in its item steps (labels, act, fix issue). Only `guardItem` makes one. */
export type GuardedItem = { readonly [guarded]: true; readonly scope: "item"; readonly action: ItemWant; readonly repo: string; readonly number: number };
/** What the guard let through for a repo-level write (a label set, a fork, an issue, a batch branch): the approval and the global switch held. Only `guardRepo` makes one. */
export type GuardedRepo = { readonly [guarded]: true; readonly scope: "repo"; readonly need: Approval | null; readonly repo: string };
/** Any of the three: what a write function that is not tied to one kind of target accepts. */
export type Grant = Guarded | GuardedItem | GuardedRepo;
export type Refused = { refused: string };
/** An item action to guard: the Plan must hold the kind with the bucket, decision and source given. */
export type ItemWant = Want & { decisionId?: string; source?: string };
/** The action to guard: `head` is the head the caller reviewed or worked on. `batch`: a member of a merge batch, which is in its batch state, not ready. */
export type Ask = Want & { head: string; batch?: boolean };
export type Ref = { repo: string; number: number };

export type LiveRead = { state: "OPEN" | "MERGED" | "CLOSED"; head: string; draft: boolean; mergeable: string };
export type Live = (repo: string, number: number) => Promise<LiveRead | null>;

/** The live read of the merge step: fetches the PR's checks (and stores them), which carry head, state, draft and mergeable. */
export function liveOf(db: DatabaseSync, q: Querier): Live {
  return async (repo, number) => {
    const [c] = await refreshChecks(db, q, repo, [number]);
    return c ? { state: c.state as LiveRead["state"], head: c.head_oid, draft: c.is_draft, mergeable: c.mergeable ?? "UNKNOWN" } : null;
  };
}

const short = (s: string | null): string => (s ?? "none").slice(0, 7);
const BATCH_STATES: readonly string[] = ["batch-checking", "in-batch"];

/** Merges and pushes read GitHub first: the head must not have moved. */
const needsLive = (a: Want): boolean =>
  a.kind === "merge" || (a.kind === "fixup" && a.bucket === "fix") || (a.kind === "conflict" && a.bucket === "merge")
  || (a.kind === "cifix" && (a.bucket === "work" || a.bucket === "collect"));

const make = (ref: Ref, a: Want, head: string): Guarded => ({ scope: "pr", action: a, head, repo: ref.repo, number: ref.number }) as Guarded;

async function check(db: DatabaseSync, ref: Ref, a: Ask, by: By, live?: Live): Promise<{ f: PrFacts } | Refused> {
  const name = `${ref.repo}#${ref.number}`;
  let read: LiveRead | null = null;
  if (needsLive(a)) {
    if (!live) return { refused: `${name}: no live read of the PR before the write` };
    try {
      read = await live(ref.repo, ref.number);
    } catch (e) {
      return { refused: `${name}: live read failed: ${String((e as Error).message ?? e).replace(/\s+/g, " ").slice(0, 200)}` };
    }
    if (!read) return { refused: `${name}: GitHub returned no such PR` };
    if (read.state !== "OPEN") return { refused: `${name}: no longer open on GitHub (${read.state.toLowerCase()})` };
    if (read.head !== a.head) return { refused: `${name}: head moved from ${short(a.head)} to ${short(read.head)} since the review` };
  }
  let f = loadPrFact(db, ref.repo, ref.number);
  if (!f) return { refused: `${name}: not an open PR the pipeline tracks` };
  if (read) f = { ...f, ghState: read.state, head: read.head, draft: read.draft, mergeable: read.mergeable };
  const why = gates(f, a, by);
  if (why) return { refused: `${name}: ${why}` };
  if (a.batch && f.mergeHeld) return { refused: `${name}: merge held by an operator` };
  const plan = decidePr(f);
  const holds = plan.head === a.head && (plan.actions.some((x) => x.kind === a.kind && x.head === a.head && (a.bucket === undefined || x.params?.bucket === a.bucket))
    || (a.batch === true && a.kind === "merge" && BATCH_STATES.includes(plan.state) && plan.path !== null));
  if (!holds) {
    const now = plan.actions.map((x) => x.kind + (typeof x.params?.bucket === "string" ? `:${x.params.bucket}` : "")).join(", ") || "none";
    return { refused: `${name}: the plan no longer has ${a.kind}${a.bucket ? `:${a.bucket}` : ""} at ${short(a.head)} (state ${plan.state}, head ${short(plan.head)}, actions: ${now}${plan.wait ? `, waiting for ${plan.wait}` : ""})` };
  }
  return { f };
}

/** Lets one PR write through, or says why not. Call it right before the write. */
export async function guard(db: DatabaseSync, ref: Ref, action: Ask, by: By, live?: Live): Promise<Guarded | Refused> {
  const r = await check(db, ref, action, by, live);
  if ("refused" in r) return r;
  return make(ref, action, action.head);
}

/**
 * Lets the merge of a batch PR through: every member must pass the guard at its batched head, and the batch PR must
 * still be open at the batch tip. The returned value is for the batch PR.
 */
export async function guardBatchMerge(db: DatabaseSync, batch: Ref & { head: string }, members: { number: number; head: string }[], by: By, live: Live): Promise<Guarded | Refused> {
  for (const m of members) {
    const r = await guard(db, { repo: batch.repo, number: m.number }, { kind: "merge", head: m.head, batch: true }, by, live);
    if ("refused" in r) return r;
  }
  const name = `${batch.repo}#${batch.number}`;
  let read: LiveRead | null;
  try {
    read = await live(batch.repo, batch.number);
  } catch (e) {
    return { refused: `${name}: live read failed: ${String((e as Error).message ?? e).replace(/\s+/g, " ").slice(0, 200)}` };
  }
  if (!read) return { refused: `${name}: GitHub returned no such PR` };
  if (read.state !== "OPEN") return { refused: `${name}: no longer open on GitHub (${read.state.toLowerCase()})` };
  if (read.head !== batch.head) return { refused: `${name}: the batch branch moved from ${short(batch.head)} to ${short(read.head)}` };
  return make(batch, { kind: "merge" }, batch.head);
}

/** Lets an issue or PR write of the item steps through while decideItem still has the action for the item. No GitHub read: the caller reads what it needs. */
export async function guardItem(db: DatabaseSync, ref: Ref, action: ItemWant, by: By): Promise<GuardedItem | Refused> {
  const name = `${ref.repo}#${ref.number}`;
  const f = loadItemFact(db, ref.repo, ref.number);
  if (!f) return { refused: `${name}: not an open item the pipeline tracks` };
  const why = gates(f, action, by);
  if (why) return { refused: `${name}: ${why}` };
  const plan = decideItem(f);
  const holds = plan.actions.some((x) => x.kind === action.kind
    && (action.bucket === undefined || x.params?.bucket === action.bucket)
    && (action.decisionId === undefined || x.params?.decisionId === action.decisionId)
    && (action.source === undefined || x.params?.source === action.source));
  if (!holds) {
    const now = plan.actions.map((x) => x.kind + (typeof x.params?.bucket === "string" ? `:${x.params.bucket}` : "")).join(", ") || "none";
    return { refused: `${name}: the plan no longer has ${action.kind}${action.bucket ? `:${action.bucket}` : ""} (state ${plan.state}, actions: ${now})` };
  }
  return { scope: "item", action, repo: ref.repo, number: ref.number } as unknown as GuardedItem;
}

/** The approvals of a repo and the global switch, read now. */
export function repoApprovals(db: DatabaseSync, repo: string): Parameters<typeof gateRepo>[0] {
  const on = (db.prepare("SELECT value FROM main.settings WHERE key = 'pipeline_enabled'").get() as { value: string } | undefined)?.value === "1";
  return {
    merge: !!mergeApprovalOf(db, repo), push: pushApprovalOf(db, repo) !== null, comment: commentApprovalOf(db, repo) !== null, ci: ciApprovalOf(db, repo) !== null,
    labels: labelsApprovalOf(db, repo) !== null, "fix-issue": fixIssueApprovalOf(db, repo) !== null, "main-fix": mainFixApprovalOf(db, repo) !== null, pipelineOn: on,
  };
}

/** Lets a repo-level write through (no item behind it): the repo approval it needs (null: none) and, for the pipeline's own writes, the global switch. */
export function guardRepo(db: DatabaseSync, repo: string, need: Approval | null, by: By): GuardedRepo | Refused {
  const why = gateRepo(repoApprovals(db, repo), need, by, repo);
  return why ? { refused: `${repo}: ${why}` } : ({ scope: "repo", need, repo } as unknown as GuardedRepo);
}
