// Decisions (home): the queue of open decisions, answering and undo, and the
// Answered tab. Cards stay short; detail lives behind the expander and on the
// item page.
import type { DatabaseSync } from "node:sqlite";
import { audit } from "../audit.ts";
import type { Req, Res } from "../types.ts";
import {
  exceptionsOf, factsOf, getDecision, isBatch, itemsOf, KINDS, optionsOf, reposOf,
  type DecisionRow, type Exception, type Ref,
} from "../../decisions.ts";
import { ago, badRequest, chips, selectFilter, csrfField, esc, exporting, forbidden, itemHref, itemLink, num, page, pageNo, pager, PAGE_SIZE, parseJson, withQuery } from "./layout.ts";

const KIND_LABEL: Record<string, [string, string]> = {
  scope: ["scope", "scope"], duplicate: ["duplicate", "duplicates"], close: ["close", "closes"],
  merge: ["merge", "merges"], split: ["split", "splits"], other: ["other", "other"],
};
const kindLabel = (k: string, n: number): string => (KIND_LABEL[k] ?? [k, k])[n === 1 ? 0 : 1];

// canWrite is cached by the server, but a page asks for the same repo once
// per card, so remember the answers for this request.
const writeMemo = new WeakMap<Req, Map<string, Promise<boolean>>>();
function canWrite(req: Req, repo: string): Promise<boolean> {
  if (exporting(req)) return Promise.resolve(false);
  let m = writeMemo.get(req);
  if (!m) writeMemo.set(req, (m = new Map()));
  let p = m.get(repo);
  if (!p) m.set(repo, (p = req.user.canWrite(repo).catch(() => false)));
  return p;
}

async function blockedRepos(req: Req, d: DecisionRow): Promise<string[]> {
  const repos = reposOf(d);
  const ok = await Promise.all(repos.map((r) => canWrite(req, r)));
  return repos.filter((_, i) => !ok[i]);
}

function whyNot(blocked: string[], batch: boolean): string {
  if (!batch) return `You can't answer this: you have no write access to storytold/${blocked[0]}.`;
  return `You can't answer this batch: no write access to ${blocked.map((r) => `storytold/${r}`).join(", ")}.`;
}

type ItemLite = { repo: string; number: number; title: string | null; kind: string; state: string };
const itemStmt = (db: DatabaseSync) => db.prepare("SELECT repo, number, title, kind, state FROM items WHERE repo = ? AND number = ?");

function classLines(db: DatabaseSync, repo: string, n: number): string {
  // latest verdict per classifier
  const rows = db.prepare(`SELECT classifier, type_label, want, reason FROM classifications c
    WHERE repo = ? AND number = ? AND at = (SELECT MAX(at) FROM classifications x WHERE x.repo = c.repo AND x.number = c.number AND x.classifier = c.classifier)
    ORDER BY classifier`).all(repo, n) as { classifier: string; type_label: string | null; want: string | null; reason: string | null }[];
  if (!rows.length) return "";
  return `<p><b>Classifiers</b></p><ul>${rows.map((r) => `<li>${esc(r.classifier)}: ${esc(r.type_label ?? "–")}, want ${esc(r.want ?? "–")}${r.reason ? ` — ${esc(r.reason)}` : ""}</li>`).join("")}</ul>`;
}

export function relatedItems(db: DatabaseSync, repo: string, n: number): Ref[] {
  const out = new Map<string, Ref>();
  const add = (r: Ref) => {
    if (r.repo === repo && r.number === n) return;
    out.set(`${r.repo}#${r.number}`, r);
  };
  for (const r of db.prepare("SELECT DISTINCT dup_of FROM classifications WHERE repo = ? AND number = ? AND dup_of IS NOT NULL").all(repo, n) as { dup_of: number }[])
    add({ repo, number: r.dup_of });
  for (const r of db.prepare("SELECT DISTINCT number FROM classifications WHERE repo = ? AND dup_of = ? LIMIT 10").all(repo, n) as { number: number }[])
    add({ repo, number: r.number });
  const it = db.prepare("SELECT closing_issues FROM items WHERE repo = ? AND number = ?").get(repo, n) as { closing_issues: string | null } | undefined;
  for (const x of parseJson<number[]>(it?.closing_issues, [])) if (Number.isInteger(x)) add({ repo, number: x });
  return [...out.values()].slice(0, 10);
}

function optionLabel(d: DecisionRow, key: string | null): string {
  return optionsOf(d).find((o) => o.key === key)?.label ?? key ?? "";
}

function cardHead(db: DatabaseSync, d: DecisionRow): string {
  if (isBatch(d)) {
    const n = itemsOf(d).length;
    const repos = reposOf(d);
    return `<div class=head><span>batch · ${num(n)} items · ${esc(repos.length === 1 ? repos[0] : `${repos.length} repos`)}</span><span>· ${esc(ago(d.asked_at))} old</span></div>`;
  }
  const it = itemStmt(db).get(d.repo, d.number) as ItemLite | undefined;
  return `<div class=head>${itemLink(d.repo!, d.number!)}<span class=title>${esc(it?.title ?? "")}</span><span>· ${esc(ago(d.asked_at))} old</span></div>`;
}

function batchList(db: DatabaseSync, req: Req, d: DecisionRow, withOverrides: boolean): string {
  const refs = itemsOf(d);
  const st = itemStmt(db);
  const opts = optionsOf(d);
  const ex = new Map(exceptionsOf(d).map((e) => [`${e.repo}#${e.number}`, e.answer]));
  const listId = `b-${d.id.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  const fold = !withOverrides && !exporting(req);
  const rows = refs.map((r, i) => {
    const it = st.get(r.repo, r.number) as ItemLite | undefined;
    const sel = withOverrides
      ? ` <select name="ex:${esc(`${r.repo}#${r.number}`)}" aria-label="Answer for ${esc(`${r.repo}#${r.number}`)}"><option value="">same as batch</option>${opts.map((o) => `<option value="${esc(o.key)}">${esc(o.label)}</option>`).join("")}</select>`
      : ex.has(`${r.repo}#${r.number}`) ? ` <b>→ ${esc(optionLabel(d, ex.get(`${r.repo}#${r.number}`)!))}</b>` : "";
    return `<li${fold && i >= 5 ? " hidden" : ""}>${itemLink(r.repo, r.number)} ${esc(it?.title ?? "")}${sel}</li>`;
  }).join("");
  const more = fold && refs.length > 5 && !exporting(req) ? `<button type=button class=link data-showall="${listId}">Show all ${num(refs.length)}</button>` : "";
  return `<ul${fold ? ` id="${listId}"` : ""}>${rows}</ul>${more}`;
}

async function card(db: DatabaseSync, req: Req, d: DecisionRow): Promise<string> {
  const batch = isBatch(d);
  const exp = exporting(req);
  const blocked = exp ? [] : await blockedRepos(req, d);
  const can = !exp && blocked.length === 0;
  const opts = optionsOf(d);
  const facts = factsOf(d);
  const factList = facts.length ? `<ul class=facts>${facts.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>` : "";
  let detail = d.context ? `<p>${esc(d.context)}</p>` : "";
  if (d.public_text) detail += `<p><b>Will be posted publicly:</b> ${esc(d.public_text)}</p>`;
  if (!batch) {
    detail += classLines(db, d.repo!, d.number!);
    const rel = relatedItems(db, d.repo!, d.number!);
    if (rel.length) detail += `<p><b>Related</b> ${rel.map((r) => itemLink(r.repo, r.number)).join(", ")}</p>`;
    detail += `<p><a href="${itemHref(d.repo!, d.number!)}">Item page</a></p>`;
  }
  const head = cardHead(db, d);
  const count = batch ? `<p class=muted>${num(itemsOf(d).length)} items. First five:</p>` : "";
  if (!can) {
    const optsLine = `<p class=small>Options: ${opts.map((o) => esc(o.label) + (o.key === d.recommended ? " (recommended)" : "")).join(" · ")}</p>`;
    const why = exp ? "" : `<p class=why>${esc(whyNot(blocked, batch))}</p>`;
    const items = batch ? batchList(db, req, d, false) : "";
    return `<article class=card data-card>${head}<p class=q>${esc(d.question)}</p>${count}${items}${factList}${optsLine}${why}` +
      (detail ? `<details><summary>More</summary>${detail}</details>` : "") + `</article>`;
  }
  const buttons = opts.map((o) => `<button type=submit name=answer value="${esc(o.key)}"${o.key === d.recommended ? " class=rec" : ""}>${esc(o.label)}${o.key === d.recommended ? " · recommended" : ""}</button>`).join("");
  const items = batch ? batchList(db, req, d, false) : "";
  const overrides = batch ? `<details><summary>Different answer for some items</summary>${batchList(db, req, d, true)}</details>` : "";
  return `<article class=card data-card>${head}<p class=q>${esc(d.question)}</p>${count}${items}${factList}
    <form method=post action="/decisions/answer" data-inline>${csrfField(req)}<input type=hidden name=id value="${esc(d.id)}"><input type=hidden name=back value="${esc(req.path)}">
    <div class=opts>${buttons}</div>
    <input type=text name=note class=note maxlength=500 placeholder="Note (optional, private)" aria-label="Note">${overrides}</form>` +
    (detail ? `<details><summary>More</summary>${detail}</details>` : "") + `</article>`;
}

function undoForm(req: Req, d: DecisionRow): string {
  return `<form method=post action="/decisions/undo" class=inline data-inline>${csrfField(req)}<input type=hidden name=id value="${esc(d.id)}"><input type=hidden name=back value="${esc(req.path)}"><button type=submit class=link>Undo</button></form>`;
}

function target(d: DecisionRow): string {
  return isBatch(d) ? `batch of ${num(itemsOf(d).length)}` : itemLink(d.repo!, d.number!);
}

function confirmation(req: Req, d: DecisionRow, canUndo: boolean): string {
  const ex = exceptionsOf(d).length;
  return `<div class=done data-card>Answered “${esc(optionLabel(d, d.answer))}” for ${target(d)}${ex ? `, ${num(ex)} exceptions` : ""}.${canUndo && !d.applied_at ? ` ${undoForm(req, d)}` : ""}</div>`;
}

type Filter = { where: string; params: Record<string, string> };

function filter(req: Req, answered: boolean, repoOverride?: string): Filter {
  const w = [answered ? "answer IS NOT NULL" : "answer IS NULL"];
  const params: Record<string, string> = {};
  const repo = repoOverride ?? req.query.get("repo");
  if (repo) {
    w.push("(repo = :repo OR (number IS NULL AND items LIKE :like))");
    params.repo = repo;
    params.like = `%"repo":${JSON.stringify(repo)}%`;
  }
  const kind = req.query.get("kind");
  if (kind && (KINDS as readonly string[]).includes(kind)) {
    w.push("kind = :kind");
    params.kind = kind;
  }
  const age = Number(req.query.get("age"));
  if ([1, 3, 7].includes(age)) {
    w.push("asked_at <= :before");
    params.before = new Date(Date.now() - age * 86400_000).toISOString();
  }
  return { where: w.join(" AND "), params };
}

const ORDER = `CASE kind ${KINDS.map((k, i) => `WHEN '${k}' THEN ${i}`).join(" ")} ELSE 9 END, number IS NOT NULL, COALESCE(repo, ''), asked_at`;

function summaryLine(db: DatabaseSync, f: Filter): { text: string; total: number } {
  const rows = db.prepare(`SELECT kind, COUNT(*) AS n, MIN(asked_at) AS oldest FROM decisions WHERE ${f.where} GROUP BY kind ORDER BY n DESC`).all(f.params) as { kind: string; n: number; oldest: string }[];
  const total = rows.reduce((s, r) => s + r.n, 0);
  if (!total) return { text: "No decisions are waiting for you.", total };
  const oldest = rows.reduce((m, r) => (r.oldest < m ? r.oldest : m), rows[0].oldest);
  const parts = rows.map((r) => `${num(r.n)} ${kindLabel(r.kind, r.n)}`).join(", ");
  return { text: `${num(total)} decision${total === 1 ? "" : "s"}: ${parts}; oldest ${ago(oldest)}.`, total };
}

function filterChips(db: DatabaseSync, req: Req): string {
  const repos = (db.prepare("SELECT DISTINCT repo FROM decisions WHERE repo IS NOT NULL ORDER BY repo").all() as { repo: string }[]).map((r) => ({ value: r.repo, label: r.repo }));
  return (repos.length > 6 ? selectFilter(req, "repo", "Repo", repos) : chips(req, "repo", "Repo", repos)) +
    chips(req, "kind", "Kind", KINDS.map((k) => ({ value: k, label: k }))) +
    chips(req, "age", "Older than", [{ value: "1", label: "1 day" }, { value: "3", label: "3 days" }, { value: "7", label: "7 days" }]);
}

function tabs(req: Req, answered: boolean): string {
  const q = new URLSearchParams(req.query);
  q.delete("page");
  q.delete("done");
  const s = q.toString() ? `?${q}` : "";
  return `<nav class=tabs><a href="/${s}"${answered ? "" : ' aria-current="page"'}>Waiting</a><a href="/answered${s}"${answered ? ' aria-current="page"' : ""}>Answered</a></nav>`;
}

async function cardsWithGroups(db: DatabaseSync, req: Req, rows: DecisionRow[]): Promise<string> {
  let out = "";
  let group = "";
  for (const d of rows) {
    const g = `${d.kind}|${isBatch(d) ? "batch" : d.repo}`;
    if (g !== group) {
      group = g;
      out += `<h2>${esc(kindLabel(d.kind, 2))} · ${isBatch(d) ? "batches" : esc(d.repo)}</h2>`;
    }
    out += await card(db, req, d);
  }
  return out;
}

export async function home(db: DatabaseSync, req: Req): Promise<Res> {
  const f = filter(req, false);
  const s = summaryLine(db, f);
  const rows = db.prepare(`SELECT * FROM decisions WHERE ${f.where} ORDER BY ${ORDER} LIMIT ${PAGE_SIZE} OFFSET ${(pageNo(req) - 1) * PAGE_SIZE}`).all(f.params) as DecisionRow[];
  let flash = "";
  const done = req.query.get("done");
  if (done) {
    const d = getDecision(db, done);
    if (d?.answer) flash = confirmation(req, d, (await blockedRepos(req, d)).length === 0);
  }
  const body = `${tabs(req, false)}<p class=summary>${esc(s.text)}</p>${filterChips(db, req)}${flash}${await cardsWithGroups(db, req, rows)}${pager(req, s.total)}`;
  return page(req, "Decisions", body);
}

// Open decisions for one repo, for the Repo page.
export async function decisionList(db: DatabaseSync, req: Req, opts: { repo: string; limit: number }): Promise<string> {
  const f = filter({ ...req, query: new URLSearchParams() }, false, opts.repo);
  const rows = db.prepare(`SELECT * FROM decisions WHERE ${f.where} ORDER BY ${ORDER} LIMIT ${opts.limit}`).all(f.params) as DecisionRow[];
  if (!rows.length) return `<p class=muted>No open decisions.</p>`;
  return cardsWithGroups(db, req, rows);
}

export async function answeredTab(db: DatabaseSync, req: Req): Promise<Res> {
  const f = filter(req, true);
  const since = new Date(Date.now() - 7 * 86400_000).toISOString();
  const where = `${f.where} AND (applied_at IS NULL OR applied_at >= :since)`;
  const params = { ...f.params, since };
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM decisions WHERE ${where}`).get(params) as { n: number }).n;
  const pending = (db.prepare(`SELECT COUNT(*) AS n FROM decisions WHERE ${where} AND applied_at IS NULL`).get(params) as { n: number }).n;
  const rows = db.prepare(`SELECT * FROM decisions WHERE ${where} ORDER BY applied_at IS NOT NULL, COALESCE(applied_at, answered_at) DESC LIMIT ${PAGE_SIZE} OFFSET ${(pageNo(req) - 1) * PAGE_SIZE}`).all(params) as DecisionRow[];
  const exp = exporting(req);
  let out = "";
  let section = "";
  for (const d of rows) {
    const sec = d.applied_at ? "Applied by the pipeline (last 7 days)" : "Answered, not yet applied";
    if (sec !== section) {
      section = sec;
      out += `<h2>${sec}</h2>`;
    }
    const canUndo = !d.applied_at && !exp && (await blockedRepos(req, d)).length === 0;
    const note = d.answer_note && !exp ? `<div class="small muted">Note: ${esc(d.answer_note)}</div>` : "";
    const ex = exceptionsOf(d).length;
    out += `<div class=card><div class=head>${target(d)}<span>· ${esc(d.kind)}</span><span>· ${esc(d.answered_by ?? "")}, ${esc(ago(d.answered_at))} ago</span></div>` +
      `<p class=q>${esc(d.question)}</p><p>Answer: <b>${esc(optionLabel(d, d.answer))}</b>${ex ? `, ${num(ex)} exceptions` : ""}${d.applied_at ? ` · applied ${esc(ago(d.applied_at))} ago` : ""}${canUndo ? ` ${undoForm(req, d)}` : ""}</p>${note}</div>`;
  }
  const summary = total ? `${num(total)} answered: ${num(pending)} waiting for the pipeline, ${num(total - pending)} applied in the last 7 days.` : "Nothing answered recently.";
  return page(req, "Answered", `${tabs(req, true)}<p class=summary>${esc(summary)}</p>${filterChips(db, req)}${out}${pager(req, total)}`);
}

function backTo(req: Req): string {
  const b = req.form.get("back") ?? "/";
  return b.startsWith("/") && !b.startsWith("//") ? b : "/";
}

export async function answer(db: DatabaseSync, req: Req): Promise<Res> {
  const id = req.form.get("id") ?? "";
  const d = getDecision(db, id);
  if (!d) return badRequest(req, "That decision no longer exists.");
  const blocked = await (async () => {
    // always the live check, never the page memo
    const repos = reposOf(d);
    const ok = await Promise.all(repos.map((r) => req.user.canWrite(r).catch(() => false)));
    return repos.filter((_, i) => !ok[i]);
  })();
  if (blocked.length) return forbidden(req, whyNot(blocked, isBatch(d)));
  if (d.answer) return { status: 409, html: confirmation(req, d, true).replace("Answered", `Already answered by ${esc(d.answered_by)}:`) };
  const keys = new Set(optionsOf(d).map((o) => o.key));
  const ans = req.form.get("answer") ?? "";
  if (!keys.has(ans)) return badRequest(req, "Pick one of the options.");
  const note = (req.form.get("note") ?? "").trim().slice(0, 500) || null;
  let exceptions: Exception[] | null = null;
  if (isBatch(d)) {
    const inBatch = new Set(itemsOf(d).map((r) => `${r.repo}#${r.number}`));
    exceptions = [];
    for (const [k, v] of req.form) {
      if (!k.startsWith("ex:") || !v || v === ans) continue;
      const ref = k.slice(3);
      if (!inBatch.has(ref) || !keys.has(v)) return badRequest(req, "An item answer doesn't match the batch.");
      const i = ref.lastIndexOf("#");
      exceptions.push({ repo: ref.slice(0, i), number: Number(ref.slice(i + 1)), answer: v });
    }
  }
  const at = new Date().toISOString();
  const r = db.prepare(`UPDATE main.decisions SET answer = ?, answer_note = ?, exceptions = ?, answered_by = ?, answered_at = ?
    WHERE id = ? AND answer IS NULL`).run(ans, note, exceptions ? JSON.stringify(exceptions) : null, req.user.login, at, id);
  if (r.changes !== 1) return { status: 409, html: `<div class="done err" data-card>Someone answered this a moment ago.</div>` };
  audit(db, req.user.login, "answer", id, { answer: ans, exceptions: exceptions ?? undefined, note: note ? true : undefined });
  if (req.form.get("js") === "1") return { html: confirmation(req, getDecision(db, id)!, true) };
  const back = backTo(req);
  return { redirect: `${back}${back.includes("?") ? "&" : "?"}done=${encodeURIComponent(id)}` };
}

export async function undo(db: DatabaseSync, req: Req): Promise<Res> {
  const id = req.form.get("id") ?? "";
  const d = getDecision(db, id);
  if (!d) return badRequest(req, "That decision no longer exists.");
  const repos = reposOf(d);
  const ok = await Promise.all(repos.map((r) => req.user.canWrite(r).catch(() => false)));
  const blocked = repos.filter((_, i) => !ok[i]);
  if (blocked.length) return forbidden(req, whyNot(blocked, isBatch(d)).replace("answer", "undo"));
  if (!d.answer) return badRequest(req, "That decision has no answer to undo.");
  if (d.applied_at) return { status: 409, html: `<div class="done err" data-card>The pipeline already acted on this answer; it can't be undone here.</div>` };
  const r = db.prepare(`UPDATE main.decisions SET answer = NULL, answer_note = NULL, exceptions = NULL, answered_by = NULL, answered_at = NULL
    WHERE id = ? AND answer IS NOT NULL AND applied_at IS NULL`).run(id);
  if (r.changes !== 1) return { status: 409, html: `<div class="done err" data-card>The pipeline acted on this a moment ago.</div>` };
  audit(db, req.user.login, "undo", id, { answer: d.answer });
  const back = backTo(req);
  if (req.form.get("js") === "1") {
    const fresh = getDecision(db, id)!;
    return { html: await card(db, { ...req, path: back.split("?")[0] }, fresh) };
  }
  return { redirect: back };
}
