// Classifiers: how often two classifiers agree on the same items, per field.
import type { DatabaseSync } from "node:sqlite";
import type { Req, Res } from "../types.ts";
import { esc, itemLink, num, page, pageNo, pager, PAGE_SIZE, pct } from "./layout.ts";

const FIELDS = { type_label: "Type label", want: "Want" } as const;
type Field = keyof typeof FIELDS;

// Only each classifier's latest verdict on an item counts.
const fresh = (a: string): string =>
  `NOT EXISTS (SELECT 1 FROM classifications n WHERE n.repo = ${a}.repo AND n.number = ${a}.number AND n.classifier = ${a}.classifier AND n.at > ${a}.at)`;

type Cell = { ca: string; cb: string; ta: string | null; tb: string | null; wa: string | null; wb: string | null; n: number };
type Pair = { ca: string; cb: string; n: number; t_agree: number; t_n: number; w_agree: number; w_n: number; cells: Cell[] };

// One pass over every pair of verdicts on the same item; pairs and both
// confusion matrices are summed from the same rows.
function pairs(db: DatabaseSync): Pair[] {
  const cells = db.prepare(`SELECT x.classifier AS ca, y.classifier AS cb, x.type_label AS ta, y.type_label AS tb, x.want AS wa, y.want AS wb, COUNT(*) AS n
    FROM classifications x JOIN classifications y ON y.repo = x.repo AND y.number = x.number AND y.classifier > x.classifier
    WHERE ${fresh("x")} AND ${fresh("y")}
    GROUP BY ca, cb, ta, tb, wa, wb`).all() as Cell[];
  const m = new Map<string, Pair>();
  for (const c of cells) {
    const k = `${c.ca}\u0000${c.cb}`;
    let p = m.get(k);
    if (!p) m.set(k, (p = { ca: c.ca, cb: c.cb, n: 0, t_agree: 0, t_n: 0, w_agree: 0, w_n: 0, cells: [] }));
    p.n += c.n;
    p.cells.push(c);
    if (c.ta !== null && c.tb !== null) { p.t_n += c.n; if (c.ta === c.tb) p.t_agree += c.n; }
    if (c.wa !== null && c.wb !== null) { p.w_n += c.n; if (c.wa === c.wb) p.w_agree += c.n; }
  }
  return [...m.values()].sort((a, b) => b.n - a.n);
}

const href = (a: string, b: string, field: string, va?: string, vb?: string): string => {
  const q = new URLSearchParams({ a, b, field });
  if (va !== undefined) q.set("va", va);
  if (vb !== undefined) q.set("vb", vb);
  return `/classifiers/items?${q}`;
};

function matrix(p: Pair, field: Field): string {
  const a = p.ca, b = p.cb;
  const sums = new Map<string, { va: string; vb: string; n: number }>();
  for (const c of p.cells) {
    const va = (field === "type_label" ? c.ta : c.wa) ?? "–";
    const vb = (field === "type_label" ? c.tb : c.wb) ?? "–";
    const k = `${va}\u0000${vb}`;
    const e = sums.get(k) ?? { va, vb, n: 0 };
    e.n += c.n;
    sums.set(k, e);
  }
  const rows = [...sums.values()];
  if (!rows.length) return `<p class=muted>No items judged by both.</p>`;
  const rowsK = [...new Set(rows.map((r) => r.va))].sort();
  const colsK = [...new Set(rows.map((r) => r.vb))].sort();
  const m = new Map(rows.map((r) => [`${r.va}\u0000${r.vb}`, r.n]));
  const agree = rows.filter((r) => r.va === r.vb).reduce((s, r) => s + r.n, 0);
  const total = rows.reduce((s, r) => s + r.n, 0);
  const head = `<tr><th>${esc(a)} ↓ / ${esc(b)} →</th>${colsK.map((c) => `<th class=n>${esc(c)}</th>`).join("")}</tr>`;
  const body = rowsK.map((r) => `<tr><th>${esc(r)}</th>${colsK.map((c) => {
    const n = m.get(`${r}\u0000${c}`) ?? 0;
    if (!n) return `<td class="n muted">·</td>`;
    const cell = num(n);
    return `<td class=n>${r === c ? `<b>${cell}</b>` : `<a href="${esc(href(a, b, field, r, c))}">${cell}</a>`}</td>`;
  }).join("")}</tr>`).join("");
  return `<p>${pct(agree / total)} agree on ${num(total)} items. <a href="${esc(href(a, b, field))}">See the ${num(total - agree)} disagreements</a>.</p><div class=scroll><table>${head}${body}</table></div>`;
}

export function classifiers(db: DatabaseSync, req: Req): Res {
  const ps = pairs(db);
  if (!ps.length) return page(req, "Classifiers", `<h1>Classifiers</h1><p class=summary>No item has been judged by two classifiers yet.</p>`);
  const qa = req.query.get("a"), qb = req.query.get("b");
  const sel = ps.find((p) => (p.ca === qa && p.cb === qb) || (p.ca === qb && p.cb === qa)) ?? ps[0];
  const table = `<div class=scroll><table><thead><tr><th>Pair</th><th class=n>Items</th><th class=n>Type label</th><th class=n>Want</th></tr></thead><tbody>${ps.map((p) =>
    `<tr><td><a href="/classifiers?a=${encodeURIComponent(p.ca)}&amp;b=${encodeURIComponent(p.cb)}"${p === sel ? ' aria-current="true"' : ""}>${esc(p.ca)} vs ${esc(p.cb)}</a></td><td class=n>${num(p.n)}</td><td class=n>${pct(p.t_n ? p.t_agree / p.t_n : null)}</td><td class=n>${pct(p.w_n ? p.w_agree / p.w_n : null)}</td></tr>`).join("")}</tbody></table></div>`;
  const body = `<h1>Classifiers</h1><p class=summary>${num(ps.length)} classifier pairs judged the same items. Agreement uses each classifier's latest verdict.</p>${table}` +
    (Object.keys(FIELDS) as Field[]).map((f) => `<h2>${esc(sel.ca)} vs ${esc(sel.cb)}: ${FIELDS[f]}</h2>${matrix(sel, f)}`).join("");
  return page(req, "Classifiers", body);
}

export function disagreements(db: DatabaseSync, req: Req): Res {
  const a = req.query.get("a") ?? "", b = req.query.get("b") ?? "";
  const field = (req.query.get("field") ?? "type_label") as Field;
  if (!(field in FIELDS)) return page(req, "Classifiers", `<p>Unknown field.</p>`);
  const va = req.query.get("va"), vb = req.query.get("vb");
  const cond = [`COALESCE(x.${field}, '–') <> COALESCE(y.${field}, '–')`];
  const params: (string | number)[] = [b, a];
  if (va !== null) { cond.push(`COALESCE(x.${field}, '–') = ?`); params.push(va); }
  if (vb !== null) { cond.push(`COALESCE(y.${field}, '–') = ?`); params.push(vb); }
  const from = `FROM classifications x JOIN classifications y ON y.repo = x.repo AND y.number = x.number AND y.classifier = ?
    WHERE x.classifier = ? AND ${fresh("x")} AND ${fresh("y")} AND ${cond.join(" AND ")}`;
  const total = (db.prepare(`SELECT COUNT(*) AS n ${from}`).get(...params) as { n: number }).n;
  const rows = db.prepare(`SELECT x.repo, x.number, x.${field} AS va, y.${field} AS vb, i.title ${from.replace("\n    WHERE", " LEFT JOIN items i ON i.repo = x.repo AND i.number = x.number WHERE")}
    ORDER BY x.repo, x.number LIMIT ${PAGE_SIZE} OFFSET ${(pageNo(req) - 1) * PAGE_SIZE}`).all(...params) as { repo: string; number: number; va: string | null; vb: string | null; title: string | null }[];
  const body = `<h1>${esc(a)} vs ${esc(b)}: ${esc(FIELDS[field])}</h1><p class=summary>${num(total)} items where they disagree${va !== null ? `; ${esc(a)} said ${esc(va)}` : ""}${vb !== null ? `; ${esc(b)} said ${esc(vb)}` : ""}. <a href="/classifiers?a=${encodeURIComponent(a)}&amp;b=${encodeURIComponent(b)}">Back to the matrix</a></p>` +
    `<div class=scroll><table><thead><tr><th>Item</th><th>${esc(a)}</th><th>${esc(b)}</th></tr></thead><tbody>${rows.map((r) =>
      `<tr><td>${itemLink(r.repo, r.number)} <span class=small>${esc(r.title ?? "")}</span></td><td>${esc(r.va ?? "–")}</td><td>${esc(r.vb ?? "–")}</td></tr>`).join("")}</tbody></table></div>${pager(req, total)}`;
  return page(req, "Classifier disagreements", body);
}
