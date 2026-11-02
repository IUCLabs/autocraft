// Shared page frame, escaping and small HTML helpers for every dashboard page.
import type { Req, Res } from "../types.ts";

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

// Every value from the data passes through this: titles and bodies come from
// strangers on GitHub.
export function esc(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).replace(/[&<>"']/g, (c) => ESC[c]);
}

// Export mode: the static copy renders pages without write controls or
// private fields. Set only by exportSite on the Req it builds.
export type PageReq = Req & { exporting?: boolean };
export const exporting = (req: Req): boolean => (req as PageReq).exporting === true;

export const csrfField = (req: Req): string => `<input type=hidden name=csrf value="${esc(req.csrf)}">`;

export const num = (n: number | null | undefined): string => (n ?? 0).toLocaleString("en-US");
export const pct = (x: number | null | undefined): string => (x === null || x === undefined || !Number.isFinite(x) ? "–" : `${Math.round(x * 100)}%`);

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "–";
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min`;
  if (s < 86400) return `${Math.round(s / 3600)} h`;
  const d = Math.round(s / 86400);
  return `${d} day${d === 1 ? "" : "s"}`;
}

export const day = (iso: string | null | undefined): string => (iso ? iso.slice(0, 10) : "–");

export const itemHref = (repo: string, n: number | string): string => `/item/${encodeURIComponent(repo)}/${encodeURIComponent(String(n))}`;
export const itemLink = (repo: string, n: number | string): string => `<a href="${itemHref(repo, n)}">${esc(repo)}#${esc(n)}</a>`;
export const repoLink = (repo: string): string => `<a href="/repo/${encodeURIComponent(repo)}">${esc(repo)}</a>`;

// A link to the same path with some query parameters replaced; "" or null removes one.
export function withQuery(req: Req, changes: Record<string, string | number | null>): string {
  const q = new URLSearchParams(req.query);
  for (const [k, v] of Object.entries(changes)) {
    if (v === null || v === "") q.delete(k);
    else q.set(k, String(v));
  }
  if (!("page" in changes)) q.delete("page");
  const s = q.toString();
  return s ? `${req.path}?${s}` : req.path;
}

export const PAGE_SIZE = 50;

export function pageNo(req: Req): number {
  const n = Number(req.query.get("page") ?? "1");
  return Number.isInteger(n) && n > 0 ? n : 1;
}

export function pager(req: Req, total: number): string {
  const page = pageNo(req);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (pages <= 1) return "";
  const prev = page > 1 ? `<a class=btn href="${esc(withQuery(req, { page: page - 1 }))}">Previous</a>` : "";
  const next = page < pages ? `<a class=btn href="${esc(withQuery(req, { page: page + 1 }))}">Next</a>` : "";
  return `<nav class=pager>${prev}<span>Page ${page} of ${pages}</span>${next}</nav>`;
}

// Filter chips: one row of links per filter; the active value is marked.
export function chips(req: Req, name: string, label: string, values: { value: string; label: string }[]): string {
  const cur = req.query.get(name) ?? "";
  const all = [{ value: "", label: "all" }, ...values];
  return `<div class=chips role=group aria-label="${esc(label)}"><span class=muted>${esc(label)}</span>` +
    all.map((v) => `<a class="chip${v.value === cur ? " on" : ""}" href="${esc(withQuery(req, { [name]: v.value }))}"${v.value === cur ? ' aria-current="true"' : ""}>${esc(v.label)}</a>`).join("") +
    "</div>";
}

// A dropdown filter for long value lists; a GET form, so it works without JS
// and the choice lands in the URL.
export function selectFilter(req: Req, name: string, label: string, values: { value: string; label: string }[]): string {
  const cur = req.query.get(name) ?? "";
  const keep = [...req.query].filter(([k]) => k !== name && k !== "page" && k !== "done")
    .map(([k, v]) => `<input type=hidden name="${esc(k)}" value="${esc(v)}">`).join("");
  const opts = [{ value: "", label: "all" }, ...values]
    .map((v) => `<option value="${esc(v.value)}"${v.value === cur ? " selected" : ""}>${esc(v.label)}</option>`).join("");
  return `<form method=get action="${esc(req.path)}" class="chips row">${keep}<label class=muted>${esc(label)} <select name="${esc(name)}" data-autosubmit>${opts}</select></label><button type=submit>Show</button></form>`;
}

// A sortable column header for tables whose sort lives in ?sort=.
export function sortHeader(req: Req, key: string, label: string, numeric = true): string {
  const cur = req.query.get("sort") ?? "";
  return `<th${numeric ? " class=n" : ""}><a href="${esc(withQuery(req, { sort: key }))}"${cur === key ? ' aria-current="true"' : ""}>${esc(label)}</a></th>`;
}

const NAV: [string, string][] = [
  ["/", "Decisions"],
  ["/progress", "Progress"],
  ["/contributors", "Contributors"],
  ["/classifiers", "Classifiers"],
  ["/cost", "Run and cost"],
];

const CSS = `
:root{color-scheme:light dark;--bg:#f9f9f7;--card:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--line:#dddcd7;--accent:#2a78d6;--accent-ink:#fff;--s2:#eb6834;--s3:#1baf7a;--good:#0ca30c;--bad:#d03b3b;--chip:#ecebe6}
@media (prefers-color-scheme:dark){:root{--bg:#0d0d0d;--card:#1a1a19;--ink:#f0efec;--ink2:#c3c2b7;--line:#383835;--accent:#3987e5;--accent-ink:#fff;--s2:#d95926;--s3:#199e70;--good:#0ca30c;--bad:#e66767;--chip:#2a2a28}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;overflow-wrap:anywhere}
a{color:var(--accent)}
header{display:flex;flex-wrap:wrap;align-items:center;gap:4px 12px;padding:4px 16px;border-bottom:1px solid var(--line);background:var(--card)}
header nav{display:flex;flex-wrap:wrap;gap:0 4px;flex:1}
header nav a{display:inline-flex;align-items:center;min-height:44px;padding:0 8px;text-decoration:none;color:var(--ink2)}
header nav a[aria-current]{color:var(--ink);font-weight:600;box-shadow:inset 0 -3px 0 var(--accent)}
header .me{display:flex;align-items:center;gap:8px;color:var(--ink2);font-size:14px}
main{max-width:1100px;margin:0 auto;padding:12px 16px 48px}
h1{font-size:22px;margin:8px 0}
h2{font-size:18px;margin:24px 0 8px}
.summary{color:var(--ink2);margin:4px 0 12px}
.muted{color:var(--ink2)}
.small{font-size:14px}
button,.btn{display:inline-flex;align-items:center;justify-content:center;min-height:44px;min-width:44px;padding:0 14px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--ink);font:inherit;text-decoration:none;cursor:pointer}
button.rec{border:2px solid var(--accent);font-weight:600}
button.link{border:0;background:none;color:var(--accent);padding:0 4px;text-decoration:underline}
input[type=text],input[type=number],select{min-height:44px;padding:0 10px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--ink);font:inherit;max-width:100%}
.chips{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:6px 0}
.chip{display:inline-flex;align-items:center;min-height:36px;padding:0 12px;border-radius:18px;background:var(--chip);color:var(--ink);text-decoration:none;font-size:14px}
.chip.on{background:var(--accent);color:var(--accent-ink)}
.tabs{display:flex;gap:4px;margin:8px 0;border-bottom:1px solid var(--line)}
.tabs a{display:inline-flex;align-items:center;min-height:44px;padding:0 12px;text-decoration:none;color:var(--ink2)}
.tabs a[aria-current]{color:var(--ink);font-weight:600;box-shadow:inset 0 -3px 0 var(--accent)}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px;margin:10px 0}
.card .head{display:flex;flex-wrap:wrap;gap:4px 8px;align-items:baseline;font-size:14px;color:var(--ink2)}
.card .title{color:var(--ink);font-size:15px}
.card .q{font-weight:600;margin:6px 0}
.card ul.facts{margin:4px 0 8px;padding-left:18px;color:var(--ink2);font-size:14px}
.card .opts{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0}
.card .note{width:100%}
.card details{margin-top:8px;font-size:14px}
.card summary{min-height:44px;display:flex;align-items:center;cursor:pointer;color:var(--accent)}
.done{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--good);border-radius:8px;padding:8px 12px;margin:10px 0;display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.why{color:var(--ink2);font-size:14px;margin:6px 0}
.err{border-left:4px solid var(--bad)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin:8px 0}
.tile{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px}
.tile b{display:block;font-size:24px;font-variant-numeric:tabular-nums}
.tile span{color:var(--ink2);font-size:14px}
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;max-width:100%}
table{border-collapse:collapse;width:100%;font-size:14px;background:var(--card)}
th,td{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line);vertical-align:top}
th a{color:var(--ink);text-decoration:none}
th a[aria-current]{text-decoration:underline}
.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.pager{display:flex;align-items:center;gap:12px;margin:16px 0}
.chart{width:100%;height:auto;display:block}
.chart text{fill:var(--ink2);font-size:12px}
.chart .bar{fill:var(--accent)}
.chart .s1{fill:var(--accent)}.chart .s2{fill:var(--s2)}.chart .s3{fill:var(--s3)}
.legend .sw-s1{background:var(--accent)}.legend .sw-s2{background:var(--s2)}.legend .sw-s3{background:var(--s3)}
.chart .line{fill:none;stroke:var(--accent);stroke-width:2}
.chart .grid{stroke:var(--line);stroke-width:1}
.legend{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:14px;color:var(--ink2)}
.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:4px;vertical-align:-1px}
.inline{display:inline}
form.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.timeline{list-style:none;padding:0;margin:0}
.timeline li{padding:6px 0;border-bottom:1px solid var(--line)}
dl.kv{display:grid;grid-template-columns:max-content 1fr;gap:4px 12px;margin:8px 0}
dl.kv dt{color:var(--ink2)}dl.kv dd{margin:0}
pre.body{white-space:pre-wrap;font:13px/1.4 ui-monospace,monospace;background:var(--chip);padding:8px;border-radius:6px;max-height:300px;overflow:auto}
`;

// Answering in place: forms marked data-inline post with fetch and swap the
// card for the returned fragment. Without JS they post normally.
const JS = `
document.addEventListener("submit", async (e) => {
  const f = e.target;
  if (!(f instanceof HTMLFormElement) || !f.hasAttribute("data-inline")) return;
  e.preventDefault();
  const body = new URLSearchParams(new FormData(f, e.submitter));
  body.set("js", "1");
  const box = f.closest("[data-card]") || f;
  try {
    const r = await fetch(f.action, { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" } });
    const html = await r.text();
    const t = document.createElement("template");
    t.innerHTML = html;
    box.replaceWith(t.content);
  } catch { f.submit(); }
});
document.addEventListener("change", (e) => {
  const s = e.target;
  if (s instanceof HTMLSelectElement && s.hasAttribute("data-autosubmit")) s.form.submit();
});
document.addEventListener("click", (e) => {
  const b = e.target.closest && e.target.closest("[data-showall]");
  if (!b) return;
  const list = document.getElementById(b.getAttribute("data-showall"));
  if (list) list.querySelectorAll("[hidden]").forEach((x) => x.removeAttribute("hidden"));
  b.remove();
});
`;

export function layout(req: Req, title: string, body: string): string {
  const exp = exporting(req);
  const nav = NAV.map(([href, label]) => {
    const on = href === "/" ? req.path === "/" || req.path === "/answered" : req.path.startsWith(href);
    return `<a href="${href}"${on ? ' aria-current="page"' : ""}>${label}</a>`;
  }).join("");
  const access = req.user.role === "admin" && !exp ? `<a href="/access"${req.path.startsWith("/access") ? ' aria-current="page"' : ""}>Access</a>` : "";
  const repos = req.user.role === "admin" && !exp ? `<a href="/repos"${req.path.startsWith("/repos") ? ' aria-current="page"' : ""}>Repos</a>` : "";
  const me = exp ? "" : `<div class=me><span>${esc(req.user.login)}</span><form method=post action="/auth/signout" class=inline>${csrfField(req)}<button type=submit class=link>Sign out</button></form></div>`;
  return `<!doctype html><html lang=en><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">` +
    `<title>${esc(title)} · Triage</title><style nonce="${esc(req.nonce)}">${CSS}</style></head><body>` +
    `<header><nav>${nav}${repos}${access}</nav>${me}</header><main>${body}</main>` +
    (exp ? "" : `<script nonce="${esc(req.nonce)}">${JS}</script>`) + `</body></html>`;
}

export const page = (req: Req, title: string, body: string): Res => ({ html: layout(req, title, body) });

export const notFound = (req: Req, what = "Not found"): Res => ({ status: 404, html: layout(req, "Not found", `<h1>${esc(what)}</h1>`) });

export function forbidden(req: Req, reason: string): Res {
  const js = req.form.get("js") === "1";
  const line = `<div class="done err" data-card>${esc(reason)}</div>`;
  return { status: 403, html: js ? line : layout(req, "Not allowed", `<h1>Not allowed</h1><p>${esc(reason)}</p>`) };
}

export function badRequest(req: Req, reason: string): Res {
  const js = req.form.get("js") === "1";
  const line = `<div class="done err" data-card>${esc(reason)}</div>`;
  return { status: 400, html: js ? line : layout(req, "Bad request", `<h1>Bad request</h1><p>${esc(reason)}</p>`) };
}

export const parseJson = <T>(s: string | null | undefined, fallback: T): T => {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};
