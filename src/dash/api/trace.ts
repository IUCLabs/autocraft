// The item trace: every event of one GitHub item, newest first, from the tables that hold per-item history.
// Each source is a small function that returns events for the item through an index on (repo, number) or a
// key derived from it; the list carries no bodies. A source also keeps the fields its detail view shows.
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ItemTrace, ItemTraceDetail, ItemTraceHeader, TraceActor, TraceEvent, TraceKind } from "../../../web/src/api/types.ts";
import { HttpError } from "../server/util.ts";
import type { Req } from "../types.ts";
import { needVisible } from "./visible.ts";

type Ev = TraceEvent & { detail?: Record<string, unknown> };
type Ctx = { db: DatabaseSync; repo: string; n: number; ref: string; own: string };
type Source = { kinds: TraceKind[]; run: (c: Ctx) => Ev[] };

export const TRACE_PAGE_DEFAULT = 100, TRACE_PAGE_MAX = 500;
const KINDS: TraceKind[] = ["github", "plan", "job", "model-call", "check", "review", "decision", "write", "step", "conversation"];

const step = (name: string): TraceActor => ({ type: "step", name });
const person = (name: string | null | undefined): TraceActor => ({ type: "person", name: name || "unknown" });
const model = (name: string | null | undefined, fallback: string): TraceActor => ({ type: "model", name: name || fallback });
const clip = (s: string | null | undefined, n = 140): string => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const json = <T>(s: string | null | undefined, fallback: T): T => { try { return s ? (JSON.parse(s) as T) : fallback; } catch { return fallback; } };
const rows = <T>(db: DatabaseSync, sql: string, ...args: (string | number)[]): T[] => db.prepare(sql).all(...args) as T[];
const count = (xs: unknown[]): string => `${xs.length} finding${xs.length === 1 ? "" : "s"}`;

const github: Source = {
  kinds: ["github"],
  run({ db, repo, n, own }) {
    const out: Ev[] = [];
    const it = db.prepare("SELECT kind, author, created_at, closed_at, merged_at, merged_by, head_oid FROM items WHERE repo = ? AND number = ?").get(repo, n) as
      { kind: string; author: string | null; created_at: string | null; closed_at: string | null; merged_at: string | null; merged_by: string | null; head_oid: string | null } | undefined;
    if (it?.created_at) out.push({ id: "gh:opened", kind: "github", at: it.created_at, head: null, actor: person(it.author), summary: `Opened ${it.kind === "pr" ? "pull request" : "issue"}`, ref: {} });
    if (it?.merged_at) out.push({ id: "gh:merged", kind: "github", at: it.merged_at, head: it.head_oid, actor: person(it.merged_by), summary: "Merged", ref: {} });
    else if (it?.closed_at) out.push({ id: "gh:closed", kind: "github", at: it.closed_at, head: null, actor: person(null), summary: "Closed", ref: {} });
    for (const c of rows<{ id: string; kind: string | null; author: string | null; created_at: string; review_state: string | null; commit_oid: string | null; len: number }>(db,
      "SELECT id, kind, author, created_at, review_state, commit_oid, LENGTH(COALESCE(body, '')) AS len FROM comments WHERE repo = ? AND number = ?", repo, n)) {
      const ours = own !== "" && c.author === own;
      const what = c.kind === "review" ? `review (${(c.review_state ?? "commented").toLowerCase().replace("_", " ")})` : "comment";
      out.push({
        id: `comment:${c.id}`, kind: "github", at: c.created_at, head: c.commit_oid, actor: ours ? step("AutoCraft") : person(c.author),
        summary: `${ours ? "AutoCraft posted a" : "Posted a"} ${what}, ${c.len} characters`, ref: { commentId: c.id },
      });
    }
    return out;
  },
};

const stages: Source = {
  kinds: ["plan"],
  run: ({ db, repo, n }) => rows<{ rowid: number; stage: string; at: string; actor: string | null; note: string | null }>(db,
    "SELECT rowid, stage, at, actor, note FROM stages WHERE repo = ? AND number = ?", repo, n)
    .map((s) => ({ id: `stage:${s.rowid}`, kind: "plan" as const, at: s.at, head: null, actor: step(s.actor || "pipeline"), summary: `Stage ${s.stage}${s.note ? `: ${clip(s.note)}` : ""}`, ref: {} })),
};

const plans: Source = {
  kinds: ["plan"],
  run: ({ db, repo, n }) => rows<{ id: number; head: string | null; old_state: string | null; new_state: string; wait: string | null; reasons: string; at: string }>(db,
    "SELECT id, head, old_state, new_state, wait, reasons, at FROM plan_history WHERE repo = ? AND number = ?", repo, n)
    .map((p) => ({
      id: `plan:${p.id}`, kind: "plan" as const, at: p.at, head: p.head, actor: step("planner"),
      summary: `Plan ${p.old_state ? `${p.old_state} → ` : "started as "}${p.new_state}${p.wait ? `, waiting for ${clip(p.wait, 80)}` : ""}`,
      ref: p.head ? { head: p.head } : {}, detail: { from: p.old_state, to: p.new_state, wait: p.wait, reasons: json<string[]>(p.reasons, []) },
    })),
};

const jobs: Source = {
  kinds: ["job"],
  run: ({ db, repo, n }) => rows<{ id: number; job_id: number; outcome: string | null; at: string; step: string | null; state: string | null; error: string | null }>(db,
    "SELECT ji.id, ji.job_id, ji.outcome, ji.at, j.step, j.state, j.error FROM job_items ji LEFT JOIN jobs j ON j.id = ji.job_id WHERE ji.repo = ? AND ji.number = ?", repo, n)
    .map((j) => ({
      id: `job:${j.id}`, kind: "job" as const, at: j.at, head: null, actor: step(j.step ?? "job"),
      summary: `${j.step ?? "Job"}: ${clip(j.outcome) || j.state || "ran"}`, ref: { jobId: j.job_id }, detail: { step: j.step, state: j.state, outcome: j.outcome, error: j.error },
    })),
};

const modelCalls: Source = {
  kinds: ["model-call"],
  run: ({ db, repo, n }) => rows<{ id: number; step: string; model: string; provider: string; state: string; started_at: string; ended_at: string | null; input_tokens: number | null; output_tokens: number | null;
    cost_usd: number | null; summary: string | null; label: string | null; tools: number; job_id: number | null }>(db,
    `SELECT r.id, r.step, r.model, r.provider, r.state, r.started_at, r.ended_at, r.input_tokens, r.output_tokens, r.cost_usd, r.summary, r.job_id,
       COALESCE(a.label, r.account_id) AS label, (SELECT COUNT(*) FROM agent_run_tools t WHERE t.run_id = r.id) AS tools
     FROM agent_run_items i JOIN agent_runs r ON r.id = i.run_id LEFT JOIN claude_accounts a ON a.id = r.account_id WHERE i.repo = ? AND i.number = ?`, repo, n)
    .map((r) => ({
      id: `run:${r.id}`, kind: "model-call" as const, at: r.started_at, head: null, actor: model(r.model, "model"),
      summary: `${r.step}: ${r.state === "running" ? "running" : r.state === "failed" ? "failed" : clip(r.summary, 100) || "done"}`,
      ref: { runId: r.id, ...(r.job_id !== null ? { jobId: r.job_id } : {}) },
      call: { model: r.model, provider: r.provider, account: r.label, state: r.state, inputTokens: r.input_tokens, outputTokens: r.output_tokens, costUsd: r.cost_usd, toolCalls: r.tools, endedAt: r.ended_at },
    })),
};

const checks: Source = {
  kinds: ["check"],
  run({ db, repo, n }) {
    const out: Ev[] = [];
    for (const c of rows<{ id: number; run_id: number | null; step: string; head: string; command: string; crate: string | null; test_name: string | null; task_id: number | null; outcome: string | null; started_at: string }>(db,
      "SELECT id, run_id, step, head, command, crate, test_name, task_id, outcome, started_at FROM model_checks WHERE repo = ? AND number = ?", repo, n))
      out.push({
        id: `check:${c.id}`, kind: "check", at: c.started_at, head: c.head, actor: step(c.step),
        summary: `check ${c.command}${c.crate ? ` ${c.crate}` : ""}${c.test_name ? ` ${c.test_name}` : ""}: ${c.outcome ?? "running"}`,
        ref: { checkId: c.id, head: c.head, ...(c.run_id !== null ? { runId: c.run_id } : {}), ...(c.task_id !== null ? { taskId: c.task_id } : {}) },
      });
    for (const t of rows<{ id: number; job_id: number | null; step: string; head_sha: string; state: string; summary: string | null; queued_at: string }>(db,
      "SELECT id, job_id, step, head_sha, state, summary, queued_at FROM build_tasks WHERE repo = ? AND number = ?", repo, n))
      out.push({
        id: `task:${t.id}`, kind: "check", at: t.queued_at, head: t.head_sha, actor: step(t.step),
        summary: `Build task ${t.state}${t.summary ? `: ${clip(t.summary, 100)}` : ""}`, ref: { taskId: t.id, head: t.head_sha, ...(t.job_id !== null ? { jobId: t.job_id } : {}) },
      });
    for (const p of rows<{ id: number; at: string; stage: string; action: string; to_oid: string; before_res: string; after_res: string | null; outcome: string | null }>(db,
      "SELECT id, at, stage, action, to_oid, before_res, after_res, outcome FROM push_outcomes WHERE repo = ? AND number = ?", repo, n))
      out.push({
        id: `push:${p.id}`, kind: "check", at: p.at, head: p.to_oid, actor: step(p.stage),
        summary: `Our push (${p.action}): required checks ${p.before_res} → ${p.after_res ?? "pending"}${p.outcome ? `, ${p.outcome}` : ""}`, ref: { head: p.to_oid },
      });
    for (const p of rows<{ id: number; kind: string; subject: string; round: number; verdict: string; model: string; reasons: string; created_at: string }>(db,
      "SELECT id, kind, subject, round, verdict, model, reasons, created_at FROM patch_checks WHERE repo = ? AND number = ?", repo, n))
      out.push({
        id: `patchcheck:${p.id}`, kind: "check", at: p.created_at, head: null, actor: model(p.model, "model"), summary: `Patch check (${p.kind}, round ${p.round}): ${p.verdict}`,
        ref: {}, detail: { subject: p.subject, reasons: p.reasons },
      });
    return out;
  },
};

type OpusRow = { head_oid: string; at: string; model: string | null; mode: string | null; verdict: string | null; sure: number | null; reason: string | null; risks: string | null; fixes: string | null };
const opusEvent = (r: OpusRow, key: string): Ev => ({
  id: `review:${key}`, kind: "review", at: r.at, head: r.head_oid, actor: model(r.model, "opus"),
  summary: `Review (${r.mode ?? "full"}): ${r.verdict ?? "no verdict"}${r.sure === 0 ? ", not sure" : ""}`, ref: { reviewId: key, head: r.head_oid },
  detail: { verdict: r.verdict, sure: r.sure === 1, reason: r.reason, fixes: json<unknown[]>(r.fixes, []), risks: json<string[]>(r.risks, []) },
});

const reviews: Source = {
  kinds: ["review"],
  run({ db, repo, n }) {
    const out: Ev[] = [];
    const seen = new Set<string>();
    for (const r of rows<OpusRow & { rowid: number }>(db, "SELECT rowid, head_oid, at, model, mode, verdict, sure, reason, risks, fixes FROM opus_review_history WHERE repo = ? AND number = ?", repo, n)) {
      seen.add(`${r.head_oid}|${r.at}`);
      out.push(opusEvent(r, `opus:${r.rowid}`));
    }
    // Reviews stored before the history table existed.
    for (const r of rows<OpusRow>(db, "SELECT head_oid, at, model, mode, verdict, sure, reason, risks, fixes FROM opus_reviews WHERE repo = ? AND number = ?", repo, n))
      if (!seen.has(`${r.head_oid}|${r.at}`)) out.push(opusEvent(r, `opus-latest:${r.head_oid}`));
    for (const r of rows<{ head_oid: string; at: string; model: string | null; findings: string | null; error: string | null; searched: string | null }>(db,
      "SELECT head_oid, at, model, findings, error, searched FROM premerge_reviews WHERE repo = ? AND number = ?", repo, n)) {
      const f = json<unknown[]>(r.findings, []);
      out.push({
        id: `review:premerge:${r.head_oid}`, kind: "review", at: r.at, head: r.head_oid, actor: model(r.model, "premerge"),
        summary: r.error ? `Pre-merge review failed: ${clip(r.error, 100)}` : `Pre-merge review: ${count(f)}`,
        ref: { reviewId: `premerge:${r.head_oid}`, head: r.head_oid }, detail: { findings: f, searched: r.searched, error: r.error },
      });
    }
    for (const r of rows<{ merge_sha: string; at: string; model: string | null; findings: string | null; error: string | null }>(db,
      "SELECT merge_sha, at, model, findings, error FROM postmerge_reviews WHERE repo = ? AND number = ?", repo, n)) {
      const f = json<unknown[]>(r.findings, []);
      out.push({
        id: `review:postmerge:${r.merge_sha}`, kind: "review", at: r.at, head: r.merge_sha, actor: model(r.model, "postmerge"),
        summary: r.error ? `Post-merge review failed: ${clip(r.error, 100)}` : `Post-merge review: ${count(f)}`,
        ref: { reviewId: `postmerge:${r.merge_sha}`, head: r.merge_sha }, detail: { findings: f, error: r.error },
      });
    }
    for (const v of rows<{ head_sha: string; kind: string; state: string; reason: string; summary: string | null; note: string | null; created_at: string; head_task_id: number | null }>(db,
      "SELECT head_sha, kind, state, reason, summary, note, created_at, head_task_id FROM verifications WHERE repo = ? AND number = ?", repo, n))
      out.push({
        id: `verify:${v.head_sha}`, kind: "review", at: v.created_at, head: v.head_sha, actor: step("verify"), summary: `Verification (${v.kind}): ${v.state}`,
        ref: { head: v.head_sha, ...(v.head_task_id !== null ? { taskId: v.head_task_id } : {}) }, detail: { reason: v.reason, summary: v.summary, note: v.note },
      });
    return out;
  },
};

const decisions: Source = {
  kinds: ["decision"],
  run({ db, repo, n }) {
    const out: Ev[] = [];
    for (const d of rows<{ id: string; kind: string; question: string; asked_at: string; asked_by: string | null; answer: string | null; answered_at: string | null; answered_by: string | null }>(db,
      "SELECT id, kind, question, asked_at, asked_by, answer, answered_at, answered_by FROM decisions WHERE repo = ? AND number = ?", repo, n)) {
      out.push({ id: `decision:${d.id}:asked`, kind: "decision", at: d.asked_at, head: null, actor: step(d.asked_by || "decide"), summary: `Asked (${d.kind}): ${clip(d.question, 100)}`, ref: { decisionId: d.id } });
      if (d.answered_at) out.push({ id: `decision:${d.id}:answered`, kind: "decision", at: d.answered_at, head: null, actor: person(d.answered_by), summary: `Answered: ${d.answer ?? ""}`, ref: { decisionId: d.id } });
      for (const c of rows<{ id: string; login: string; at: string; len: number }>(db, "SELECT id, login, at, LENGTH(body) AS len FROM decision_comments WHERE decision_id = ?", d.id))
        out.push({ id: `decision:${d.id}:feedback:${c.id}`, kind: "decision", at: c.at, head: null, actor: person(c.login), summary: `Feedback on the question, ${c.len} characters`, ref: { decisionId: d.id } });
    }
    return out;
  },
};

type FixRow = { rowid: number; head: string; to_head: string | null; state: string; reason: string | null; files: string | null; attempt: number; created_at: string; task_id?: number | null; kind?: string };
const fixEvent = (f: FixRow, id: string, name: string, label: string): Ev => ({
  id: `${id}:${f.rowid}`, kind: "step", at: f.created_at, head: f.head, actor: step(name), summary: `${label} try ${f.attempt}: ${f.state}${f.reason ? `, ${clip(f.reason, 100)}` : ""}`,
  ref: { head: f.head, ...(f.to_head ? { toHead: f.to_head } : {}), ...(f.task_id ? { taskId: f.task_id } : {}) }, detail: { to: f.to_head, reason: f.reason, files: json<string[]>(f.files, []) },
});

const steps: Source = {
  kinds: ["step"],
  run({ db, repo, n }) {
    const out: Ev[] = [];
    for (const f of rows<FixRow>(db, "SELECT rowid, from_head AS head, to_head, state, reason, files, attempt, created_at FROM fixups WHERE repo = ? AND number = ?", repo, n)) out.push(fixEvent(f, "fixup", "fixup", "Fix-up"));
    for (const f of rows<FixRow>(db, "SELECT rowid, head, to_head, kind, state, reason, files, attempt, task_id, created_at FROM ci_fixes WHERE repo = ? AND number = ?", repo, n)) out.push(fixEvent(f, "cifix", "cifix", `CI fix (${f.kind})`));
    for (const f of rows<FixRow>(db, "SELECT rowid, from_head AS head, to_head, state, reason, files, attempt, created_at FROM conflict_merges WHERE repo = ? AND number = ?", repo, n)) out.push(fixEvent(f, "conflict", "conflict", "Conflict merge"));
    for (const m of rows<{ rowid: number; head_oid: string; at: string; path: string; method: string | null; outcome: string; reason: string | null }>(db,
      "SELECT rowid, head_oid, at, path, method, outcome, reason FROM merges WHERE repo = ? AND number = ?", repo, n))
      out.push({ id: `merge:${m.rowid}`, kind: "step", at: m.at, head: m.head_oid, actor: step("merge"), summary: `Merge attempt (${m.path}${m.method ? `, ${m.method}` : ""}): ${m.outcome}${m.reason ? `, ${clip(m.reason, 100)}` : ""}`, ref: { head: m.head_oid } });
    for (const a of rows<{ id: number; decision_id: string; kind: string; state: string; reason: string | null; created_at: string }>(db,
      "SELECT id, decision_id, kind, state, reason, created_at FROM actions WHERE repo = ? AND number = ?", repo, n))
      out.push({ id: `action:${a.id}`, kind: "step", at: a.created_at, head: null, actor: step("act"), summary: `Action ${a.kind}: ${a.state}${a.reason ? `, ${clip(a.reason, 100)}` : ""}`, ref: { decisionId: a.decision_id } });
    return out;
  },
};

const conversation: Source = {
  kinds: ["conversation"],
  run: ({ db, repo, n }) => rows<{ id: number; kind: string; login: string; at: string; len: number; status: string | null }>(db,
    "SELECT id, kind, login, at, LENGTH(body) AS len, status FROM conversation_turns WHERE repo = ? AND number = ?", repo, n)
    .map((t) => ({
      id: `turn:${t.id}`, kind: "conversation" as const, at: t.at, head: null, actor: t.kind === "opus" ? model("opus", "opus") : t.kind === "system" ? step("system") : person(t.login),
      summary: `Conversation ${t.kind} message, ${t.len} characters${t.status && t.status !== "answered" ? ` (${t.status})` : ""}`, ref: {},
    })),
};

// AutoCraft's GitHub writes carry a `state` in their details (src/github/write.ts); the other audit rows are dashboard actions of operators.
// The posted text stays out: the list and the detail show its length.
const writes: Source = {
  kinds: ["write"],
  run: ({ db, ref }) => rows<{ rowid: number; at: string; login: string; action: string; details: string | null }>(db,
    "SELECT rowid, at, login, action, details FROM audit WHERE target = ?", ref)
    .map((a) => {
      const { text, ...d } = json<Record<string, unknown>>(a.details, {});
      const ours = typeof d.state === "string";
      const head = typeof d.head === "string" ? d.head : null;
      return {
        id: `audit:${a.rowid}`, kind: "write" as const, at: a.at, head, actor: ours ? step("AutoCraft") : person(a.login),
        summary: ours ? `${a.action}: ${d.state === "failed" ? `failed, ${clip(String(d.error ?? ""), 100)}` : String(d.state)}` : a.action,
        ref: { auditRowid: a.rowid, ...(head ? { head } : {}) }, detail: { action: a.action, by: a.login, ...d, ...(typeof text === "string" ? { textLength: text.length } : {}) },
      };
    }),
};

const SOURCES: Source[] = [github, stages, plans, jobs, modelCalls, checks, reviews, decisions, steps, conversation, writes];

/** Heads are known for pushes, reviews and checks only; a model call, job or decision between two of them belongs to the head current at its time. */
function carryHeads(events: Ev[]): void {
  const asc = [...events].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1));
  let current: string | null = null;
  for (const e of asc) {
    if (e.head) current = e.head;
    else if (current && (e.kind === "model-call" || e.kind === "job" || e.kind === "decision" || e.kind === "conversation")) e.head = current;
  }
}

function gather(c: Ctx, kinds: Set<TraceKind> | null): Ev[] {
  const all = SOURCES.filter((s) => !kinds || s.kinds.some((k) => kinds.has(k))).flatMap((s) => s.run(c));
  carryHeads(all);
  return (kinds ? all.filter((e) => kinds.has(e.kind)) : all).sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? 1 : -1));
}

function headerOf({ db, repo, n, own }: Ctx): ItemTraceHeader {
  const plan = db.prepare("SELECT head, state, actions, wait, reasons, note, view, planned_at FROM item_plans WHERE repo = ? AND number = ?").get(repo, n) as
    { head: string | null; state: string; actions: string; wait: string | null; reasons: string; note: string | null; view: string; planned_at: string } | undefined;
  const view = json<{ next?: string }>(plan?.view, {});
  const acts = json<{ kind: string; head?: string | null }[]>(plan?.actions, []);
  const it = db.prepare("SELECT assignees FROM items WHERE repo = ? AND number = ?").get(repo, n) as { assignees: string | null } | undefined;
  const assignees = json<string[]>(it?.assignees, []).filter((x) => typeof x === "string");
  const hold = db.prepare("SELECT held_by, held_at FROM merge_holds WHERE repo = ? AND number = ?").get(repo, n) as { held_by: string; held_at: string } | undefined;
  return {
    now: {
      state: plan?.state ?? null, head: plan?.head ?? null, plannedAt: plan?.planned_at ?? null,
      text: plan ? (view.next ?? plan.wait ?? plan.note ?? plan.state) : "Not planned yet", waitsOn: plan?.wait ?? null, reasons: json<string[]>(plan?.reasons, []), note: plan?.note ?? null,
    },
    next: acts.map((a) => ({ kind: a.kind, head: a.head ?? null })),
    who: {
      assignees, autocraftAssigned: own !== "" && assignees.includes(own),
      openDecisions: rows<{ id: string; kind: string; question: string }>(db, "SELECT id, kind, question FROM decisions WHERE repo = ? AND number = ? AND answer IS NULL ORDER BY asked_at", repo, n)
        .map((d) => ({ id: d.id, kind: d.kind, question: clip(d.question, 140) })),
      holds: hold ? [{ by: hold.held_by, at: hold.held_at }] : [],
    },
  };
}

async function context(db: DatabaseSync, req: Req): Promise<Ctx> {
  const repo = req.params.repo!;
  const n = Number(req.params.n);
  if (!Number.isInteger(n)) throw new HttpError(400, "not an item number");
  await needVisible(db, req, repo);
  if (!db.prepare("SELECT 1 FROM items WHERE repo = ? AND number = ?").get(repo, n)) throw new HttpError(404, `no item ${repo}#${n} in the mirror`);
  const own = (db.prepare("SELECT value FROM main.settings WHERE key = 'pipeline_login'").get() as { value: string } | undefined)?.value ?? "";
  return { db, repo, n, ref: `${repo}#${n}`, own };
}

const strip = ({ detail: _d, ...e }: Ev): TraceEvent => e;

export async function trace(db: DatabaseSync, req: Req): Promise<ItemTrace | { unchanged: true; stamp: string }> {
  const c = await context(db, req);
  const q = (k: string) => req.query.get(k) || undefined;
  const limitRaw = q("limit");
  if (limitRaw !== undefined && !/^\d{1,4}$/.test(limitRaw)) throw new HttpError(400, "limit must be a whole number");
  const limit = Math.min(Math.max(Number(limitRaw ?? TRACE_PAGE_DEFAULT), 1), TRACE_PAGE_MAX);
  let kinds: Set<TraceKind> | null = null;
  const kq = q("kinds");
  if (kq) {
    const list = kq.split(",");
    if (list.some((k) => !KINDS.includes(k as TraceKind))) throw new HttpError(400, `kinds are ${KINDS.join(", ")}`);
    kinds = new Set(list as TraceKind[]);
  }
  const cursor = q("cursor");
  let after: { at: string; id: string } | null = null;
  if (cursor) {
    const i = cursor.indexOf("|");
    if (i < 1) throw new HttpError(400, "bad cursor");
    after = { at: cursor.slice(0, i), id: cursor.slice(i + 1) };
  }
  let events = gather(c, kinds);
  if (q("autocraftOnly") === "1" || q("autocraftOnly") === "true") events = events.filter((e) => e.actor.type !== "person");
  const header = headerOf(c);
  // The stamp covers the header and the first page, so a client can ask "changed since?" and skip the payload.
  const stamp = createHash("sha1").update(JSON.stringify([header, events.slice(0, limit).map(strip)])).digest("hex").slice(0, 16);
  if (q("since") === stamp) return { unchanged: true, stamp };
  const rest = after ? events.filter((e) => e.at < after.at || (e.at === after.at && e.id < after.id)) : events;
  const page = rest.slice(0, limit).map(strip);
  const last = page[page.length - 1];
  return { header, events: page, nextCursor: rest.length > limit && last ? `${last.at}|${last.id}` : null, stamp };
}

/** The fields an event keeps back from the list, for the kinds whose detail has no endpoint of its own (runs, build tasks and decisions have theirs). */
export async function traceDetail(db: DatabaseSync, req: Req): Promise<ItemTraceDetail> {
  const c = await context(db, req);
  const e = gather(c, null).find((x) => x.id === (req.query.get("id") ?? ""));
  if (!e) throw new HttpError(404, "no such event");
  return { id: e.id, kind: e.kind, at: e.at, summary: e.summary, fields: e.detail ?? {} };
}
