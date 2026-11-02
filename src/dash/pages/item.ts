// Item page: where the detail lives, so decision cards can stay short.
import type { DatabaseSync } from "node:sqlite";
import type { Req, Res } from "../types.ts";
import { optionsOf, type DecisionRow } from "../../decisions.ts";
import { isWhitelisted } from "../../whitelist.ts";
import { relatedItems } from "./decisions.ts";
import { day, esc, exporting, itemLink, notFound, num, page, parseJson, repoLink } from "./layout.ts";

type Item = Record<string, string | number | null>;

const STATE_WORDS: Record<string, string> = { OPEN: "open", CLOSED: "closed", MERGED: "merged" };
const STAGE_WORDS: Record<string, string> = {
  classified: "classified", reviewed: "reviewed", take: "taken by the pipeline", hold: "held",
  close: "marked to close", "needs-decision": "waiting for a decision", batched: "put in a batch",
  merged: "merged by the pipeline", closed: "closed by the pipeline", "fixed-by-us": "fixed by us",
};

function size(it: Item): string {
  if (it.kind !== "pr") return "";
  const a = Number(it.additions ?? 0), d = Number(it.deletions ?? 0);
  const t = a + d;
  const b = t <= 50 ? "S" : t <= 300 ? "M" : t <= 1000 ? "L" : "XL";
  return `${b} (+${num(a)} −${num(d)}, ${num(Number(it.changed_files ?? 0))} files)`;
}

export function item(db: DatabaseSync, req: Req): Res {
  const repo = req.params.repo;
  const n = Number(req.params.n);
  if (!Number.isInteger(n)) return notFound(req);
  const it = db.prepare("SELECT * FROM items WHERE repo = ? AND number = ?").get(repo, n) as Item | undefined;
  if (!it) return notFound(req, `No item ${repo}#${req.params.n} in the mirror`);
  const author = it.author ? String(it.author) : null;
  const tier = author ? isWhitelisted(db, author) : null;
  const labels = parseJson<string[]>(it.labels as string, []);
  const kv: [string, string][] = [
    ["Repo", repoLink(repo)],
    ["State", esc(STATE_WORDS[String(it.state)] ?? it.state) + (it.is_draft ? " (draft)" : "")],
    ["Author", author ? `<a href="/contributors?login=${encodeURIComponent(author)}">${esc(author)}</a> · ${tier!.ok ? "whitelisted" : "not whitelisted"} <span class=muted>(${esc(tier!.reason)})</span>` : "–"],
    ["Opened", esc(day(it.created_at as string))],
  ];
  if (it.closed_at) kv.push([it.state === "MERGED" ? "Merged" : "Closed", esc(day(it.closed_at as string)) + (it.merged_by ? ` by ${esc(it.merged_by)}` : "")]);
  if (it.kind === "pr") {
    kv.push(["Size", esc(size(it))]);
    kv.push(["CI", esc(it.ci_state ?? "–")]);
    kv.push(["Mergeable", esc(it.mergeable ?? "–")]);
    if (it.review_decision) kv.push(["Review", esc(it.review_decision)]);
  }
  if (labels.length) kv.push(["Labels", labels.map(esc).join(", ")]);

  const stages = db.prepare("SELECT stage, at, actor, note FROM stages WHERE repo = ? AND number = ? ORDER BY at, rowid").all(repo, n) as { stage: string; at: string; actor: string | null; note: string | null }[];
  const timeline = stages.length
    ? `<ul class=timeline>${stages.map((s) => `<li><b>${esc(STAGE_WORDS[s.stage] ?? s.stage)}</b> <span class=muted>${esc(s.at.slice(0, 16).replace("T", " "))}${s.actor ? ` · ${esc(s.actor)}` : ""}</span>${s.note ? `<div>${esc(s.note)}</div>` : ""}</li>`).join("")}</ul>`
    : `<p class=muted>The pipeline hasn't looked at this yet.</p>`;

  const cls = db.prepare("SELECT classifier, at, type_label, want, reference, area, dup_of, reason FROM classifications WHERE repo = ? AND number = ? ORDER BY classifier, at DESC").all(repo, n) as Item[];
  const clsTable = cls.length
    ? `<div class=scroll><table><thead><tr><th>Classifier</th><th>Type</th><th>Want</th><th>Area</th><th>Reason</th></tr></thead><tbody>${cls.map((c) =>
      `<tr><td>${esc(c.classifier)}<div class="small muted">${esc(day(c.at as string))}</div></td><td>${esc(c.type_label ?? "–")}</td><td>${esc(c.want ?? "–")}</td><td>${esc(c.area ?? "–")}</td><td>${esc(c.reason ?? "")}${c.reference ? `<div class="small muted">Reference app: ${esc(c.reference)}</div>` : ""}${c.dup_of ? `<div class=small>Duplicate of ${itemLink(repo, c.dup_of as number)}</div>` : ""}</td></tr>`).join("")}</tbody></table></div>`
    : `<p class=muted>No classifications yet.</p>`;

  const like = `%{"repo":${JSON.stringify(repo)},"number":${n}}%`;
  const decisions = db.prepare(`SELECT * FROM decisions WHERE (repo = ? AND number = ?) OR (number IS NULL AND items LIKE ?) ORDER BY asked_at DESC`).all(repo, n, like) as DecisionRow[];
  const decList = decisions.length
    ? `<ul>${decisions.map((d) => {
      const opt = optionsOf(d).find((o) => o.key === d.answer)?.label;
      const state = d.answer ? `answered “${esc(opt ?? d.answer)}” by ${esc(d.answered_by)}${d.applied_at ? ", applied" : ""}` : `<a href="/?repo=${encodeURIComponent(repo)}">waiting</a>`;
      return `<li>${esc(d.question)} <span class=muted>(${d.number === null ? "batch, " : ""}${state})</span></li>`;
    }).join("")}</ul>`
    : `<p class=muted>None.</p>`;

  const rel = relatedItems(db, repo, n);
  const relList = rel.length ? `<p>${rel.map((r) => itemLink(r.repo, r.number)).join(", ")}</p>` : `<p class=muted>None found.</p>`;

  let auditBlock = "";
  if (!exporting(req)) {
    const targets = [`${repo}#${n}`, ...decisions.map((d) => d.id)];
    const rows = db.prepare(`SELECT at, login, action, target FROM audit WHERE target IN (${targets.map(() => "?").join(",")}) ORDER BY at DESC LIMIT 50`).all(...targets) as Item[];
    if (rows.length) auditBlock = `<h2>Activity</h2><ul class=timeline>${rows.map((r) => `<li>${esc(String(r.at).slice(0, 16).replace("T", " "))} · ${esc(r.login)} · ${esc(r.action)}</li>`).join("")}</ul>`;
  }

  const body = it.body ? `<details><summary>Description</summary><pre class=body>${esc(String(it.body).slice(0, 4000))}</pre></details>` : "";
  const html = `<h1>${esc(it.title)}</h1>
    <p class=summary>${esc(repo)}#${n} · ${it.kind === "pr" ? "pull request" : "issue"} · <a href="${esc(String(it.url ?? "").startsWith("https://github.com/") ? it.url : `https://github.com/storytold/${encodeURIComponent(repo)}/issues/${n}`)}">on GitHub</a></p>
    <dl class=kv>${kv.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>${body}
    <h2>Pipeline</h2>${timeline}
    <h2>Classifications</h2>${clsTable}
    <h2>Decisions</h2>${decList}
    <h2>Related</h2>${relList}${auditBlock}`;
  return page(req, `${repo}#${n}`, html);
}
