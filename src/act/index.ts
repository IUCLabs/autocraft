// Act stage: the GitHub writes that follow an operator's answer. Two kinds,
// both a short comment and a close:
//   - a scope decision answered `close` (Out of scope), on an issue or PR;
//   - a "Close this PR?" decision, which this step asks for each PR whose
//     latest review says close, once per head commit.
//   - a "Merge this PR?" decision answered `close`: the same comment and close
//     as a "Close this PR?" close.
//   - a duplicate decision answered `close` (Close as duplicate): "Duplicate of
//     #y." (or "..., which is closed.") and a close. "Not a duplicate" and "Keep
//     both" store the pair as distinct and write nothing (src/dupes/decide.ts).
// Other scope answers need no write here: take and small-extra go on to
// review, plugin makes the Label stage add the plugin candidate label (in
// repos approved for labels), need-info is checked by people. They count as
// applied once the pipeline used them (src/decisions-used.ts). Only an
// operator's answer counts (actionable()), and only in repos an operator
// approved for comments. No model calls.
//
//   autocraft act --repo R [--limit N] [--apply]
//   autocraft comment-approval [--repo R]
import { OPERATOR_MODELS } from "../prompts/index.ts";
import type { DatabaseSync } from "node:sqlite";
import { audit } from "../dash/audit.ts";
import { closeItem, commentOn, type Note, type Writer } from "../github/write.ts";
import { connect } from "../db.ts";
import { actionable, ask, factsOf, getDecision, type Actionable, type DecisionRow, type Kind } from "../decisions.ts";
import { HEAD_FACT } from "../merge/queue.ts";
import { fillReviewSummaries, reviewText } from "../review/summary.ts";
import { Client, type Querier } from "../mirror.ts";
import { headOf, sizeOf } from "../review/candidates.ts";
import { backlogHeld, backlogHeldSql, notOwnIntegrationSql } from "../dupes/held.ts";
import { applyDuplicateAnswers } from "../dupes/decide.ts";
import { commentApprovalOf } from "./approval.ts";
import { actOnGroups, type GroupIo } from "./dupe-groups.ts";
import { cleanReason, duplicateComment, ORG, prCloseComment, scopeCloseComment } from "./templates.ts";
import { inPilot, pilotSql } from "../pilot.ts";

const ACTOR = "act";
const NO_IO: GroupIo = { live: async () => null, comment: async () => "", close: async () => {} };
const KIND = "comment-close";
const DUP_FACT = "duplicate of ";
const REASON_FACT = "review reason: ";

export type ActDeps = { querier: Querier; now: () => Date };
export const defaultDeps = (): ActDeps => ({ querier: new Client(1000), now: () => new Date() });

export type ActParams = {
  repo: string;
  /** Most items to attempt in this run. */
  limit?: number;
  /** Default true: only `dryRun: false` asks, comments or closes. */
  dryRun?: boolean;
  onHandled?: (n: number) => void;
};

export type ActSummary = {
  repo: string; dryRun: boolean;
  /** Close? decisions asked (or that would be). */
  asked: string[];
  done: string[]; skipped: { ref: string; reason: string }[]; failed: { ref: string; reason: string }[];
  note: string | null;
};

/** Option keys of a "Close this PR?" decision. */
export const CLOSE_OPTIONS = {
  close: { key: "close", label: "Close", hint: "Post a short comment and close the PR." },
  hold: { key: "hold", label: "Hold", hint: "Leave it open for now." },
  keep: { key: "keep", label: "Keep open", hint: "The PR stays; do not ask again at this head commit." },
} as const;

/** One decision per PR head: a push gets a new one. */
export const closeDecisionId = (repo: string, number: number, head: string): string => `${repo}#${number}:close@${head}`;

/**
 * The GitHub write each option causes, by decision kind and option key. The
 * dashboard asks for a second confirmation on these; options not listed write
 * nothing.
 */
const WRITES: Partial<Record<Kind, Record<string, string>>> = {
  scope: { close: "closes it on GitHub" },
  close: { close: "closes the PR on GitHub" },
  duplicate: { close: "closes it on GitHub", accept: "posts the comments shown and closes the duplicates on GitHub" },
  merge: { merge: "merges on GitHub", close: "closes the PR on GitHub" },
};
export const writeEffect = (kind: Kind, optionKey: string): string | null =>
  WRITES[kind]?.[optionKey] ?? (kind === "duplicate" && optionKey.startsWith("keep:") ? WRITES.duplicate!.accept! : null);

const refOf = (e: { repo: string; number: number }) => `${e.repo}#${e.number}`;
const short = (sha: string) => sha.slice(0, 7);

// ---- Close this PR? ------------------------------------------------------------

type ReviewRow = { repo: string; number: number; head_oid: string; reason: string; sure: number | null; lines: number; title: string | null; author: string | null;
  i_head: string | null; updated_at: string | null; c_head: string | null; c_at: string | null };

/** Open PRs whose latest Opus review says close at the PR's current head and that have no Close? decision at that head. */
export function closeCandidates(db: DatabaseSync, repo: string): ReviewRow[] {
  const rows = db.prepare(`
    SELECT r.repo, r.number, r.head_oid, r.reason, r.sure, COALESCE(i.additions, 0) + COALESCE(i.deletions, 0) AS lines, i.title, i.author,
           i.head_oid AS i_head, i.updated_at, c.head_oid AS c_head, c.fetched_at AS c_at
    FROM final_reviews r
    JOIN items i ON i.repo = r.repo AND i.number = r.number AND i.kind = 'pr' AND i.state = 'OPEN' AND ${notOwnIntegrationSql("i")} AND ${pilotSql("i")} AND NOT ${backlogHeldSql("i")}
    LEFT JOIN pr_checks c ON c.repo = r.repo AND c.number = r.number
    WHERE r.repo = ? AND r.verdict = 'close'
      AND r.head_oid = (SELECT r2.head_oid FROM opus_reviews r2 WHERE r2.repo = r.repo AND r2.number = r.number AND r2.verdict IS NOT NULL ORDER BY r2.at DESC, r2.rowid DESC LIMIT 1)
    ORDER BY r.number`).all(repo) as ReviewRow[];
  const has = db.prepare("SELECT 1 FROM decisions WHERE id = ?");
  return rows.filter((r) => headOf({ head_oid: r.i_head, updated_at: r.updated_at, c_head: r.c_head, c_at: r.c_at }) === r.head_oid && !has.get(closeDecisionId(r.repo, r.number, r.head_oid)));
}

export function closeQuestion(r: ReviewRow, why: string | null = null): Record<string, unknown> & { id: string } {
  const reason = cleanReason(r.reason);
  return {
    id: closeDecisionId(r.repo, r.number, r.head_oid), kind: "close", repo: r.repo, number: r.number,
    question: "Close this PR?",
    context: `The Opus review says close${r.sure === 0 ? " (Opus was unsure)" : ""}.`,
    facts: [
      `${REASON_FACT}${r.reason.replace(/\s+/g, " ").trim().slice(0, 300)}`,
      `author: ${r.author ?? "unknown"}, size ${sizeOf(r.lines)}`,
      `${HEAD_FACT}${r.head_oid}`,
    ],
    options: Object.values(CLOSE_OPTIONS).map((o) => ({ ...o })),
    // A recommendation always comes with the review's reason for it.
    ...(why ? { recommended: "close", recommended_reason: why } : {}),
    // The reason the closing comment gives; the operator sees it in the facts.
    public_text: reason,
    asked_by: ACTOR,
  };
}

export function askCloseDecisions(db: DatabaseSync, repo: string, at: string): string[] {
  const qs = closeCandidates(db, repo).map((r) => closeQuestion(r, reviewText(db, r.repo, r.number, r.head_oid)?.why ?? null));
  if (qs.length) ask(db, qs.map((q) => ({ ...q, asked_at: at })));
  fillReviewSummaries(db, at, repo);
  return qs.map((q) => q.id);
}

// ---- what to act on ------------------------------------------------------------

type Target = { decisionId: string; kind: "scope" | "close" | "duplicate" | "merge"; repo: string; number: number };

/** Items an operator's `close` answer applies to in this repo, minus those an exception changes. */
function targetsOf(a: Actionable, repo: string): Target[] {
  if (a.kind !== "scope" && a.kind !== "close" && a.kind !== "duplicate" && a.kind !== "merge") return [];
  if (a.kind !== "scope" && a.number === null) return [];
  const out: Target[] = [];
  for (const it of a.items) {
    if (it.repo !== repo) continue;
    const ex = a.exceptions.find((e) => e.repo === it.repo && e.number === it.number);
    if ((ex ? ex.answer : a.answer) === "close") out.push({ decisionId: a.id, kind: a.kind, repo, number: it.number });
  }
  return out;
}

type ActionRow = { id: number; decision_id: string; repo: string; number: number; kind: string; state: string; comment_url: string | null; reason: string | null; created_at: string };
const rowOf = (db: DatabaseSync, t: Target): ActionRow | undefined =>
  db.prepare("SELECT * FROM actions WHERE decision_id = ? AND repo = ? AND number = ? AND kind = ?").get(t.decisionId, t.repo, t.number, KIND) as ActionRow | undefined;

/** `asked_by` of the decisions a security scan asks. An operator's close answer to one applies in any repo approved for commenting, in the pipeline or not. */
export const SECURITY_ASKER = "security-scan";
const securityAsked = (db: DatabaseSync, id: string): boolean =>
  (db.prepare("SELECT asked_by FROM decisions WHERE id = ?").get(id) as { asked_by: string | null } | undefined)?.asked_by === SECURITY_ASKER;

/** Answered-close targets in the repo without a final (done or skipped) action row. */
export function pending(db: DatabaseSync, repo: string): Target[] {
  return actionable(db).flatMap((a) => targetsOf(a, repo)).filter((t) => (inPilot(db, t.repo, t.number) || securityAsked(db, t.decisionId)) && !backlogHeld(db, t.repo, t.number)).filter((t) => {
    const r = rowOf(db, t);
    return !r || r.state === "failed";
  });
}

// ---- GitHub ----------------------------------------------------------------------

export type Live = { id: string; type: "Issue" | "PullRequest"; state: string; head: string | null };

export const READ = `query($name: String!, $n: Int!) {
  repository(owner: "${ORG}", name: $name) {
    issueOrPullRequest(number: $n) {
      __typename
      ... on Issue { id state }
      ... on PullRequest { id state headRefOid }
    }
  }
}`;

export async function readLive(q: Querier, repo: string, n: number): Promise<Live | null> {
  const d = await q.query(READ, { name: repo, n }) as { repository?: { issueOrPullRequest?: { __typename: string; id: string; state: string; headRefOid?: string } | null } };
  const x = d.repository?.issueOrPullRequest;
  if (!x) return null;
  return { id: x.id, type: x.__typename === "PullRequest" ? "PullRequest" : "Issue", state: x.state, head: x.headRefOid ?? null };
}

// ---- the step ----------------------------------------------------------------

function headFact(d: DecisionRow): string | null {
  const f = factsOf(d).find((x) => x.startsWith(HEAD_FACT));
  return f ? f.slice(HEAD_FACT.length).trim() : null;
}
const factValue = (d: DecisionRow, prefix: string): string | null => {
  const f = factsOf(d).find((x) => x.startsWith(prefix));
  return f ? f.slice(prefix.length).trim() : null;
};

/** The note for a comment posted on an operator's answer: the model that recommended the action or wrote the decision's text, when one did. */
export function decisionNote(d: DecisionRow): Note {
  if (d.asked_by === SECURITY_ASKER) return { by: "operator", model: OPERATOR_MODELS.security };
  const model = d.recommended_by ?? d.summary_by;
  return model ? { by: "operator", model } : { by: "fixed-operator" };
}

function commentFor(d: DecisionRow, t: Target): string {
  if (t.kind === "scope") return scopeCloseComment(d.public_text);
  return prCloseComment({ repo: t.repo, reason: d.public_text ?? factValue(d, REASON_FACT), duplicateOf: factValue(d, DUP_FACT) });
}

/** The exact comment the act step posts for a decision, for the dashboard. Null when none is fixed in advance. */
export function commentPreview(d: DecisionRow): string | null {
  // A group decision shows the stored texts of each option instead (src/dupes/texts.ts).
  if (d.kind === "duplicate" && d.id.includes(":dupegroup:")) return null;
  if (d.kind === "scope" || d.kind === "close" || d.kind === "merge") return commentFor(d, { decisionId: d.id, kind: d.kind, repo: d.repo ?? "", number: d.number ?? 0 });
  if (d.kind === "duplicate") {
    const orig = factValue(d, DUP_FACT);
    return orig && d.repo ? duplicateComment({ repo: d.repo, original: orig, closed: false }) : null;
  }
  return null;
}

export async function runAct(db: DatabaseSync, params: ActParams, log: (line: string) => void = console.log, deps?: ActDeps): Promise<ActSummary> {
  const { repo } = params;
  const dryRun = params.dryRun ?? true;
  if (params.limit !== undefined && !(Number.isInteger(params.limit) && params.limit >= 0)) throw new Error("limit must be a whole number ≥ 0");
  const at = () => (deps?.now() ?? new Date()).toISOString();
  const w: Writer = { db, login: ACTOR };
  const summary: ActSummary = { repo, dryRun, asked: [], done: [], skipped: [], failed: [], note: null };
  // Answers that need no GitHub write are applied whether or not commenting is approved.
  if (!dryRun) applyDuplicateAnswers(db, at());
  if (!commentApprovalOf(db, repo)) {
    summary.note = `commenting in ${repo} is not approved`;
    log(`act ${repo}: ${summary.note}; nothing done`);
    return summary;
  }
  let todo = pending(db, repo);
  if (params.limit !== undefined) todo = todo.slice(0, params.limit);
  if (dryRun) {
    summary.asked = closeCandidates(db, repo).map((r) => closeDecisionId(r.repo, r.number, r.head_oid));
    for (const id of summary.asked) log(`  would ask Close? ${id}`);
    for (const t of todo) log(`  would comment and close ${refOf(t)} (${t.decisionId})`);
    await actOnGroups(db, { repo, io: NO_IO, at, log, left: () => Infinity, handled: () => {}, dryRun: true });
    log(`act ${repo}: dry run, nothing called or written`);
    summary.done = todo.map(refOf);
    return summary;
  }
  const d = deps ?? defaultDeps();
  summary.asked = askCloseDecisions(db, repo, at());
  if (summary.asked.length) log(`  asked ${summary.asked.length} Close? decision${summary.asked.length === 1 ? "" : "s"}`);
  // Newly asked ones are unanswered, so the work list is the one taken above.

  const save = (t: Target, state: "done" | "skipped" | "failed", reason: string | null, url: string | null) => {
    const prev = rowOf(db, t);
    if (prev) db.prepare("UPDATE actions SET state = ?, reason = ?, comment_url = COALESCE(?, comment_url), created_at = ? WHERE id = ?").run(state, reason, url, at(), prev.id);
    else db.prepare("INSERT INTO actions (decision_id, repo, number, kind, state, comment_url, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(t.decisionId, t.repo, t.number, KIND, state, url, reason, at());
  };
  // A decision is applied once none of its targets is left to do.
  const settle = (t: Target) => {
    const a = actionable(db).find((x) => x.id === t.decisionId);
    if (a && !pending(db, repo).some((p) => p.decisionId === t.decisionId) && !targetsOfElsewhere(a, repo))
      db.prepare("UPDATE decisions SET applied_at = ? WHERE id = ? AND applied_at IS NULL").run(at(), t.decisionId);
  };
  const skip = (t: Target, reason: string) => {
    save(t, "skipped", reason, null);
    audit(db, ACTOR, "act-skip", refOf(t), { decision: t.decisionId, reason });
    summary.skipped.push({ ref: refOf(t), reason });
    log(`  ${refOf(t)}: skipped: ${reason}`);
    settle(t);
  };

  let handled = 0;
  for (const t of todo) {
    const dec = getDecision(db, t.decisionId)!;
    handled++;
    params.onHandled?.(handled);
    const prev = rowOf(db, t);
    try {
      const live = await readLive(d.querier, t.repo, t.number);
      if (!live) { skip(t, "GitHub returned no such item"); continue; }
      if (live.state !== "OPEN") { skip(t, `already ${live.state.toLowerCase()} on GitHub`); continue; }
      if (t.kind === "close" || t.kind === "merge") {
        const h = headFact(dec);
        if (live.type !== "PullRequest" || !h || live.head !== h) { skip(t, `head moved since the decision (${h ? short(h) : "no head recorded"} → ${live.head ? short(live.head) : "none"})`); continue; }
      }
      let url = prev?.comment_url ?? null;
      if (url === null) {
        let body: string;
        if (t.kind === "duplicate") {
          const orig = /^([\w.-]+)#(\d+)$/.exec(factValue(dec, DUP_FACT) ?? "");
          if (!orig || orig[1] !== t.repo || Number(orig[2]) === t.number) { skip(t, "the decision names no other item of this repo as the original"); continue; }
          const o = await readLive(d.querier, t.repo, Number(orig[2]));
          if (!o) { skip(t, "GitHub returned no such original"); continue; }
          body = duplicateComment({ repo: t.repo, original: `${orig[1]}#${orig[2]}`, closed: o.state !== "OPEN" });
        } else body = commentFor(dec, t);
        url = await commentOn(w, d.querier, "act-comment", { repo: t.repo, number: t.number, id: live.id }, decisionNote(dec), body, { decision: t.decisionId });
        // Saved before the close so a retry after a failed close does not comment twice.
        save(t, "failed", "comment posted; close not done yet", url);
      }
      await closeItem(w, d.querier, { repo: t.repo, number: t.number, id: live.id, pr: live.type === "PullRequest" }, { decision: t.decisionId, head: live.head });
      save(t, "done", null, url);
      db.prepare("INSERT INTO stages (repo, number, stage, at, actor, note) VALUES (?, ?, 'closed', ?, ?, ?)").run(t.repo, t.number, at(), ACTOR, `closed after ${t.kind} decision ${t.decisionId}`);
      summary.done.push(refOf(t));
      log(`  ${refOf(t)}: commented and closed`);
      settle(t);
    } catch (e) {
      const why = (e as Error).message.replace(/\s+/g, " ").slice(0, 300);
      const row = rowOf(db, t);
      save(t, "failed", why, row?.comment_url ?? null);
      summary.failed.push({ ref: refOf(t), reason: why });
      log(`  ${refOf(t)}: failed: ${why}`);
      break;
    }
  }
  // Duplicate groups: the stored comments and closes, within what is left of the limit.
  if (!summary.failed.length) {
    const io: GroupIo = {
      live: (n) => readLive(d.querier, repo, n),
      comment: (live, body, at) => commentOn(w, d.querier, "act-comment", { repo, number: at.number, id: live.id }, decisionNote(getDecision(db, at.decision)!), body, { decision: at.decision }),
      close: (live, at) => closeItem(w, d.querier, { repo, number: at.number, id: live.id, pr: live.type === "PullRequest" }, { decision: at.decision, head: live.head }),
    };
    const g = await actOnGroups(db, {
      repo, io, at, log, dryRun: false,
      left: () => (params.limit === undefined ? Infinity : params.limit - handled),
      handled: () => { handled++; params.onHandled?.(handled); },
    });
    summary.done.push(...g.done);
    summary.skipped.push(...g.skipped);
    summary.failed.push(...g.failed);
  }
  log(`act ${repo}: ${summary.done.length} closed, ${summary.skipped.length} skipped, ${summary.failed.length} failed, ${summary.asked.length} asked`);
  return summary;
}

/** True when the decision has close targets in another repo (a batch across repos), which this run does not settle. */
function targetsOfElsewhere(a: Actionable, repo: string): boolean {
  return a.items.some((i) => i.repo !== repo);
}

// ---- CLI -----------------------------------------------------------------------

function parseArgs(args: string[]): { repo: string; limit?: number; apply: boolean } {
  let repo: string | undefined, limit: number | undefined, apply = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--repo") repo = args[++i];
    else if (a === "--limit") limit = Number(args[++i]);
    else if (a === "--apply") apply = true;
    else if (a === "--dry-run") apply = false;
    else throw new Error(`unknown option ${a}; options: --repo R --limit N --apply --dry-run`);
  }
  if (!repo) throw new Error("missing --repo");
  if (limit !== undefined && !(Number.isInteger(limit) && limit >= 0)) throw new Error("--limit is a whole number");
  return { repo, limit, apply };
}

export const commands = {
  act: {
    summary: "act --repo R [--limit N] [--apply]: comment and close items an operator answered close, ask Close? for reviewed PRs (dry run unless --apply)",
    async run(args: string[]): Promise<void> {
      const f = parseArgs(args);
      await runAct(connect(), { repo: f.repo, limit: f.limit, dryRun: !f.apply });
    },
  },
  "comment-approval": {
    summary: "comment-approval [--repo R]: which repos an operator approved for comments and closes",
    run(args: string[]): void {
      const i = args.indexOf("--repo");
      const db = connect();
      const repos = i >= 0 ? [args[i + 1]!] : (db.prepare("SELECT name FROM tracked_repos ORDER BY name").all() as { name: string }[]).map((r) => r.name);
      for (const r of repos) {
        const a = commentApprovalOf(db, r);
        console.log(`${r}\t${a ? `approved by ${a.by} at ${a.at}` : "not approved"}`);
      }
    },
  },
};

