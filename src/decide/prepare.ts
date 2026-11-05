// The prepare step: one judgement-model call per open decision, so every question a person has to answer comes with
// a summary, a pick and drafted answers. The call reads what stopped the pipeline (the output of the call that asked),
// the item and, for a pull request, its diff, with read-only tools on a checkout when there is one.
// A single-item decision gets an Opus turn in the item's conversation with the drafts as proposed cards; a group decision
// gets a summary and a pick only. Our code accepts only a pick that is a key of the decision's own options.
import type { DatabaseSync } from "node:sqlite";
import { claudeRoom } from "../agents/call.ts";
import { runModelStep, type ClaudeStep } from "../agents/step.ts";
import { referenceProblems, defaultSemanticDeps, type SemanticDeps } from "../reference-lint.ts";
import { dropTexts } from "../replylint.ts";
import { referenceDir } from "../reference.ts";
import { SUMMARY_MIN, summaryInput } from "../classify/parse.ts";
import { pool } from "../classify/run.ts";
import { itemsOf, optionsOf, factsOf, type DecisionRow } from "../decisions.ts";
import { commentTexts, openDecision, parseReply, type NewCard } from "../conversations/cards.ts";
import { ensureConversation, insertTurn, opusBlock, refreshItem, turnsOf, type DiffSource } from "../conversations/store.ts";
import { CLAUDE_PROMPTS } from "../prompts/index.ts";
import { codeDiff } from "../review/diff.ts";
import { REPO_PATH } from "../sandbox/command.ts";
import { applicableSteps } from "../conversations/cards.ts";
import { pilotSql } from "../pilot.ts";
import { notOwnIntegrationSql } from "../dupes/held.ts";
import { judgementModel } from "./judgement.ts";
import { loadSummaryItems } from "./index.ts";
import { openSubjectSql, prepareDue, type PrepareColumns } from "./prepared.ts";
import { PREPARE_DIFF_LIMIT, PREPARE_MEMBERS, PREPARE_REASON_MAX, PREPARE_STOPPED_LIMIT, PREPARE_SUMMARY_MAX, PREPARE_TURNS_LIMIT, type PrepareInput } from "./prepare-types.ts";

export const PREPARE_PROMPT = CLAUDE_PROMPTS["decide.prepare"];

/** The reply as our code reads it: the pick line, the summary and, for a single item, the checked cards. */
export type Prepared = { summary: string; pick: string | null; reason: string; cards: NewCard[]; notes: string[]; /** The reply text without its pick line. */ text: string };

// "Pick: key | reason", also with markdown emphasis ("**Pick:** key") and a dash, em dash or colon before the reason.
const PICK_LINE = /^[ \t]*[*_`]*[ \t]*Pick[*_`]*[ \t]*:[*_`]*[ \t]*([^\s|\u2014\u2013]+)[ \t]*(?:[|\u2014\u2013:-]+[ \t]*(.*))?$/i;
const PICK_START = /^[ \t]*[*_`]*[ \t]*Pick[*_`]*[ \t]*:/i;
const ACTIONS_TAIL = /```actions[\s\S]*$/;

/** The pick line of a reply (the first line that starts with "Pick:"; narration before it is dropped) and the text after it. The pick is a key of `keys`, else null ("none" or anything else). `matched`: the reply has a pick line at all. */
export function splitPick(text: string, keys: string[]): { pick: string | null; reason: string; rest: string; matched: boolean } {
  const t = text.replace(/^\s+/, "");
  const lines = t.split("\n");
  const end = lines.findIndex((l) => l.trimStart().startsWith("```"));
  const at = lines.slice(0, end < 0 ? lines.length : end).findIndex((l) => PICK_START.test(l));
  if (at < 0) return { pick: null, reason: "", rest: t, matched: false };
  const first = lines[at]!;
  const after = lines.slice(at + 1).join("\n");
  const m = PICK_LINE.exec(first);
  if (!m) return { pick: null, reason: "", rest: after, matched: true };
  const key = m[1]!.replace(/^[`"'*]+|[`"'*.,;]+$/g, "");
  return { pick: keys.includes(key) ? key : null, reason: (m[2] ?? "").replace(/\s+/g, " ").trim().slice(0, PREPARE_REASON_MAX), rest: after, matched: true };
}

/**
 * Reads a prepare reply. A single item (`item` given): the text and cards come from `parseReply`; with no pick line at all the first
 * card's answer is the pick ("Pick: none" stays no pick). A group: the text is the summary and any actions block is dropped. Null: no valid summary
 * (a summary needs SUMMARY_MIN to PREPARE_SUMMARY_MAX characters), so the call is repeated.
 */
export function parsePrepareReply(db: DatabaseSync, item: { repo: string; n: number } | null, text: string, keys: string[], drop: ReadonlySet<string> = new Set()): Prepared | null {
  const { pick, reason, rest, matched } = splitPick(text, keys);
  let body: string, cards: NewCard[] = [], notes: string[] = [];
  if (item) {
    const r = parseReply(db, item.repo, item.n, rest, drop);
    if (!r) return null;
    ({ text: body, cards, notes } = r);
  } else body = rest.replace(ACTIONS_TAIL, "").trim();
  const summary = body.replace(/\s+/g, " ").trim();
  if (summary.length < SUMMARY_MIN || summary.length > PREPARE_SUMMARY_MAX) return null;
  const first = cards[0]?.params;
  const fromCard = first?.kind === "resolution" && first.settle?.kind === "answer" && keys.includes(first.settle.option) ? first.settle.option : null;
  return { summary, pick: matched ? pick : fromCard, reason: pick ? reason : "", cards, notes, text: body };
}

type PrepareCtx = { db: DatabaseSync; item: { repo: string; n: number } | null; keys: string[]; dir: string | undefined; semantic: SemanticDeps | undefined };

/** The prepare call: the reply parser and the reference lint of the drafted comments (as the conversation step has). */
export const PREPARE: ClaudeStep<PrepareInput, Prepared, PrepareCtx> = {
  provider: "claude", id: "decide.prepare",
  toPrompt: (x) => [x], size: () => 1,
  lint: { fields: ["cards[].text"], make: (_x, c) => async (text, stage) => (c.item && parsePrepareReply(c.db, c.item, text, c.keys) ? referenceProblems(commentTexts(splitPick(text, c.keys).rest), c.dir, c.semantic, { stage }) : null) },
  parse: (text, _x, ctx, c) => { const r = parsePrepareReply(c.db, c.item, text, c.keys, dropTexts(ctx.problems)); return r === null ? null : { value: r }; },
};

// ---- what is due ---------------------------------------------------------------

type DueRow = PrepareColumns & { id: string; repo: string; asked_at: string; number: number | null; kind: string | null; head_oid: string | null };

/** The head a decision is prepared for: a pull request's head commit, else null. */
const headOf = (r: { kind: string | null; head_oid: string | null }): string | null => (r.kind === "pr" ? r.head_oid : null);

/** Ids of the open decisions whose prepare is due (no prepare for the current state, tries left, backoff over), oldest decision first. The item's Plan says whether the decide step has work; this reads the decisions themselves. */
export function prepareIds(db: DatabaseSync, repos?: string[], nowMs: number = Date.now()): string[] {
  const rows = db.prepare(`SELECT d.id, d.repo, d.asked_at, d.number, d.prepared_at, d.prepared_head, d.prepare_failed_head, d.recommend_failures, d.recommend_failed_at, i.kind, i.head_oid
    FROM decisions d LEFT JOIN items i ON i.repo = d.repo AND i.number = d.number
    WHERE d.answer IS NULL AND d.repo IS NOT NULL AND d.number IS NOT NULL AND ${openSubjectSql("d", "i")} AND ${pilotSql("i")} AND ${notOwnIntegrationSql("i")} ORDER BY d.asked_at, d.id`).all() as DueRow[];
  return rows.filter((r) => !repos?.length || repos.includes(r.repo)).filter((r) => prepareDue(r, headOf(r), nowMs)).map((r) => r.id);
}

// ---- what stopped the pipeline -----------------------------------------------

const cut = (s: string | null | undefined, n: number): string => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const arr = (s: string | null): unknown[] => { try { const v = JSON.parse(s ?? "[]") as unknown; return Array.isArray(v) ? v : []; } catch { return []; } };

/**
 * The output of the call that asked the question, as stored: the question's context line; for a pull request the newest Opus review
 * (verdict, reason, fixes, risks), at the current head first; the classifiers' latest labels and reasons; the duplicate comparison that
 * lists the item; for a group decision its members and roles. Maintainers' comments and opinions on the dashboard are never read here.
 */
export function stoppedBy(db: DatabaseSync, d: DecisionRow, head: string | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (d.context) out.context = cut(d.context, 1000);
  if (d.number === null || !d.repo) return out;
  const review = db.prepare(`SELECT head_oid, verdict, sure, reason, fixes, risks FROM opus_reviews WHERE repo = ? AND number = ? AND verdict IS NOT NULL
    ORDER BY (head_oid = ?) DESC, at DESC LIMIT 1`).get(d.repo, d.number, head ?? "") as { head_oid: string; verdict: string; sure: number | null; reason: string | null; fixes: string | null; risks: string | null } | undefined;
  if (review) out.review = { at_head: review.head_oid === head, verdict: review.verdict, sure: review.sure === null ? null : review.sure === 1, reason: cut(review.reason, 1500), fixes: arr(review.fixes).slice(0, 10), risks: arr(review.risks).slice(0, 10).map((r) => cut(String(r), 400)) };
  const cls = db.prepare("SELECT classifier, at, type_label, want, reference, flags, reason, dup_of FROM classifications WHERE repo = ? AND number = ? ORDER BY at DESC").all(d.repo, d.number) as { classifier: string; type_label: string | null; want: string | null; reference: string | null; flags: string | null; reason: string | null; dup_of: number | null }[];
  const seen = new Set<string>();
  const classifications = cls.filter((c) => !seen.has(c.classifier) && seen.add(c.classifier)).map((c) => ({ classifier: c.classifier, type_label: c.type_label, want: c.want, reference_claim: cut(c.reference, 300) || null, flags: arr(c.flags), reason: cut(c.reason, 400), duplicate_of: c.dup_of }));
  if (classifications.length) out.classifications = classifications;
  const cmp = db.prepare(`SELECT kind, members, source, reason, result FROM dupe_comparisons WHERE repo = ? AND EXISTS (SELECT 1 FROM json_each(members) WHERE value = ?) ORDER BY at DESC LIMIT 2`).all(d.repo, d.number) as { kind: string; members: string; source: string; reason: string | null; result: string | null }[];
  if (cmp.length) out.duplicate_comparisons = cmp.map((c) => ({ kind: c.kind, members: arr(c.members), by: c.source, reason: cut(c.reason, 600), result: cut(c.result, 1500) }));
  if (d.id.includes(":dupegroup:")) {
    const members = db.prepare("SELECT number, kind, role, target, detail FROM dupe_group_items WHERE decision_id = ? ORDER BY number").all(d.id) as { number: number; kind: string; role: string; target: number | null; detail: string | null }[];
    if (members.length) out.group_members = members.map((m) => ({ number: m.number, kind: m.kind, role: m.role, target: m.target, detail: cut(m.detail, 400) || null }));
  }
  return out;
}

/** The operator messages of the item's conversation (the operator's own words and the posts they shared), newest last, cut from the front. */
function operatorTurns(db: DatabaseSync, repo: string, n: number): string {
  const all = turnsOf(db, repo, n).filter((t) => t.kind === "operator").map((t) => t.block).join("");
  return all.length > PREPARE_TURNS_LIMIT ? all.slice(all.length - PREPARE_TURNS_LIMIT) : all;
}

// ---- the step ----------------------------------------------------------------

export type PrepareParams = {
  /** The judgement model; default: the operator's setting. */
  model?: string;
  /** Host directory with a read-only checkout, or null to ask without tools: a pull request's head commit, else the repo's default branch. */
  checkout: (repo: string, number: number, head: string | null) => Promise<string | null>;
  /** PR diffs (also for the conversation's item block). */
  diff: DiffSource;
  usageRun: string;
  onSent?: () => void;
  cancelled?: () => boolean;
  log: (line: string) => void;
  /** The semantic reference check of drafted comments; absent: the real one. */
  semantic?: SemanticDeps;
};

export type PrepareResult = { /** Decisions prepared and stored. */ stored: number; failed: number };

type Row = DecisionRow & PrepareColumns;
type ItemRow = { kind: string; state: string; head_oid: string | null; additions: number | null; deletions: number | null; changed_files: number | null };

const now = () => new Date().toISOString();

/** One call per decision id, concurrently as the Claude room allows. */
export async function prepare(db: DatabaseSync, ids: string[], p: PrepareParams): Promise<PrepareResult> {
  const model = p.model ?? judgementModel(db);
  const checkouts = new Map<string, Promise<string | null>>();
  const select = db.prepare("SELECT * FROM decisions WHERE id = ? AND answer IS NULL");
  const itemOf = db.prepare("SELECT kind, state, head_oid, additions, deletions, changed_files FROM items WHERE repo = ? AND number = ?");
  const failed = db.prepare(`UPDATE decisions SET recommend_failures = CASE WHEN prepare_failed_head IS ? THEN COALESCE(recommend_failures, 0) + 1 ELSE 1 END,
    recommend_failed_at = ?, prepare_failed_head = ? WHERE id = ?`);
  const store = db.prepare(`UPDATE decisions SET recommended = ?, recommended_reason = ?, recommended_by = ?, summary = ?, summary_by = ?, summary_at = ?,
    prepared_at = ?, prepared_head = ?, recommend_failures = NULL, recommend_failed_at = NULL, prepare_failed_head = NULL
    WHERE id = ? AND answer IS NULL AND question = ? AND options = ?`);
  const res: PrepareResult = { stored: 0, failed: 0 };
  await pool(ids.map((id, k) => async () => {
    if (p.cancelled?.()) return;
    const d = select.get(id) as Row | undefined;
    if (!d || !d.repo || d.number === null) return;
    const repo = d.repo, n = d.number;
    const it = itemOf.get(repo, n) as ItemRow | undefined;
    if (!it) return;
    const isPr = it.kind === "pr";
    const head = isPr ? it.head_oid : null;
    const group = d.id.includes(":dupegroup:");
    // Only the decision the conversation binds its cards to (the item's newest open one) gets a turn with cards; the item's other decisions get a summary and a pick, like groups.
    const single = !group && openDecision(db, repo, n)?.id === d.id;
    const options = optionsOf(d);
    const keys = options.map((o) => o.key);
    const [item] = loadSummaryItems(db, [{ repo, number: n }]);
    if (!item) return;
    const members = group ? loadSummaryItems(db, (db.prepare("SELECT number FROM dupe_group_items WHERE decision_id = ? ORDER BY number LIMIT ?").all(d.id, PREPARE_MEMBERS) as { number: number }[]).map((m) => ({ repo, number: m.number }))) : [];
    const start = now();
    p.onSent?.();
    let prDiff: string | null = null;
    if (isPr && head) {
      const raw = await p.diff(repo, n, head).catch(() => null);
      if (raw) {
        let cd = codeDiff(raw);
        if (!cd.files.length && cd.testsOmitted.length) cd = codeDiff(raw, true);
        prDiff = cd.text.length <= PREPARE_DIFF_LIMIT ? cd.text : null;
      }
    }
    const ckey = `${repo}#${isPr ? n : 0}@${head ?? ""}`;
    if (!checkouts.has(ckey)) checkouts.set(ckey, p.checkout(repo, n, head).catch(() => null));
    const checkout = await checkouts.get(ckey)!;
    // The conversation (item block, updates) is brought up to date before the call: the drafts are stamped with what the call was told.
    if (single) {
      await ensureConversation(db, repo, n, "opus", { diff: p.diff }).catch((e) => p.log(`decide: no conversation for ${id}: ${(e as Error).message}`));
      await refreshItem(db, repo, n, { diff: p.diff }).catch(() => false);
    }
    const input: PrepareInput = {
      ref: `${repo}#${n}`, item: { ...summaryInput(item), steps: applicableSteps(db, repo, n) }, question: d.question, facts: factsOf(d),
      options: options.map((o) => ({ key: o.key, label: o.label, hint: o.hint ?? "" })),
      stopped: stoppedBy(db, d, head),
      ...(group && { group: true, members: members.map(summaryInput) }),
      ...(isPr && { pr: { head, lines: { additions: it.additions, deletions: it.deletions, files: it.changed_files }, diff: prDiff } }),
    };
    const turns = group ? "" : operatorTurns(db, repo, n);
    if (turns) input.operator_turns = turns;
    if (checkout) input.repo_dir = REPO_PATH;
    const dir = referenceDir(repo);
    const semantic = p.semantic ?? defaultSemanticDeps(db, `${repo}#${n}`);
    const r = await runModelStep(db, PREPARE, input, {
      model, checkout: checkout ?? undefined, reference: checkout ? dir : undefined,
      ctx: { db, item: single ? { repo, n } : null, keys, dir, semantic },
      usage: { run: p.usageRun, agent: `prepare-${String(k).padStart(3, "0")}`, stage: "decide", model, items: () => 1 },
      onReply: (reply) => { if (reply.fixTurn) p.log(`decide: ${id}: reply lint: ${reply.problems?.length ? `${reply.problems.length} problems left after the fix turn` : "fixed by one fix turn"}`); },
      cancelled: p.cancelled,
    });
    if (!r.ok) {
      if (p.cancelled?.()) return;
      failed.run(head, now(), head, d.id);
      res.failed++;
      p.log(`decide: no valid prepare for ${d.id}; retried in an hour, at most 3 tries`);
      return;
    }
    const got = r.value;
    // The PR moved on while the call ran: the next pass prepares it for the new head. A group's kept item may be closed; prepareIds decides whether the group is still open.
    const after = itemOf.get(repo, n) as ItemRow | undefined;
    if (!after || (!group && after.state !== "OPEN") || (isPr && after.head_oid !== head)) { p.log(`decide: ${d.id}: head moved on during the call; prepared again next pass`); return; }
    // The decision was answered or asked again while the call ran: nothing is stored, the next pass prepares what is still open.
    if (!db.prepare("SELECT 1 FROM decisions WHERE id = ? AND answer IS NULL AND question = ? AND options = ?").get(d.id, d.question, d.options)) return;
    const at = now();
    try {
      if (single) insertTurn(db, repo, n, { kind: "opus", login: "opus", body: got.text, block: opusBlock(got.text, got.cards), notes: got.notes, cards: got.cards }, { diff: p.diff });
      store.run(got.pick, got.pick ? got.reason || null : null, model, got.summary, model, at, at, head, d.id, d.question, d.options);
      res.stored++;
    } catch (e) {
      p.log(`decide: could not store the prepare of ${d.id}: ${(e as Error).message}`);
      try { failed.run(head, now(), head, d.id); } catch { /* the next pass tries again */ }
      res.failed++;
    }
  }), () => claudeRoom(db), { first: true });
  return res;
}
