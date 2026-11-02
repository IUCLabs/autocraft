"""HTML rendering. `Site` knows how to build links for the live server and the static export."""
from html import escape as e
from urllib.parse import quote

from craft_auto import whitelist
from craft_auto.dash import queries as q

CSS = """
:root{--bg:#fafafa;--fg:#1c1c1e;--mut:#6b6b70;--card:#fff;--line:#dcdce0;--acc:#2057c8;--ok:#1a7f45;--warn:#a66300;--bad:#b3261e;--bar:#2057c8}
@media(prefers-color-scheme:dark){:root{--bg:#121214;--fg:#e8e8ea;--mut:#9a9aa2;--card:#1c1c20;--line:#33333a;--acc:#7aa2ff;--ok:#4cc27f;--warn:#e0a040;--bad:#ff8a80;--bar:#7aa2ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.4 system-ui,sans-serif}
main{max-width:60rem;margin:0 auto;padding:0 12px 40px}a{color:var(--acc)}
nav{display:flex;flex-wrap:wrap;gap:4px 14px;padding:10px 12px;border-bottom:1px solid var(--line);background:var(--card);position:sticky;top:0}
nav a{text-decoration:none;font-weight:600}nav a.cur{border-bottom:2px solid var(--acc)}
h1{font-size:1.4rem;margin:16px 0 4px}h2{font-size:1.1rem;margin:22px 0 6px}h3{font-size:1rem;margin:14px 0 4px;color:var(--mut)}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 10px;margin:6px 0}
.card .top{display:flex;flex-wrap:wrap;gap:2px 8px;align-items:baseline}.q{font-weight:600;margin:4px 0}
.mut{color:var(--mut);font-size:.85rem}.tag{font-size:.75rem;border:1px solid var(--line);border-radius:10px;padding:0 7px;white-space:nowrap}
.ok{color:var(--ok);border-color:var(--ok)}.bad{color:var(--bad);border-color:var(--bad)}.warn{color:var(--warn);border-color:var(--warn)}
.add{color:var(--ok)}.del{color:var(--bad)}details summary{cursor:pointer;color:var(--mut);font-size:.85rem}
table{border-collapse:collapse;width:100%;font-size:.9rem}th,td{text-align:left;padding:4px 6px;border-bottom:1px solid var(--line)}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}.scroll{overflow-x:auto}
button{font:inherit;font-size:.8rem;padding:3px 9px;border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:6px}
form{display:inline;margin:0}svg text{fill:var(--fg);font-size:11px}svg .bar{fill:var(--bar)}svg .trk{fill:var(--line)}
"""

PAGES = [("decisions", "Decisions"), ("progress", "Progress"), ("contributors", "Contributors"), ("cost", "Cost")]


class Site:
    def __init__(self, static: bool):
        self.static = static

    def href(self, page, name=None, **qs):
        if self.static:
            return f"repo-{quote(name)}.html" if name else f"{'index' if page == 'decisions' else page}.html"
        base = f"/repo/{quote(name)}" if name else ("/" if page == "decisions" else f"/{page}")
        return base + ("?" + "&".join(f"{k}={quote(str(v))}" for k, v in qs.items()) if qs else "")


def page(site, title, cur, body):
    nav = "".join(f'<a href="{site.href(p)}"{" class=cur" if p == cur else ""}>{n}</a>' for p, n in PAGES)
    return (f'<!doctype html><html lang="en"><head><meta charset="utf-8"><title>{e(title)}</title>'
            f'<meta name="viewport" content="width=device-width,initial-scale=1"><style>{CSS}</style></head>'
            f'<body><nav>{nav}</nav><main>{body}</main></body></html>')


def item_link(repo, number, url=None, kind="pr"):
    url = url or f"https://github.com/storytold/{repo}/{'pull' if kind == 'pr' else 'issues'}/{number}"
    return f'<a href="{e(url)}" rel="noopener">{e(repo)}#{number}</a>'


def hbar(rows, width=560):
    """rows: [(label, value)] as an inline SVG bar chart."""
    if not rows:
        return '<p class="mut">No data.</p>'
    mx = max(v for _, v in rows) or 1
    lw, h = 110, 20
    out = [f'<svg viewBox="0 0 {width} {len(rows) * h + 4}" width="100%" role="img">']
    for i, (label, v) in enumerate(rows):
        y = i * h + 2
        w = (width - lw - 60) * v / mx
        out.append(f'<text x="0" y="{y + 13}">{e(str(label))[:18]}</text>'
                   f'<rect class="bar" x="{lw}" y="{y + 2}" width="{max(w, 1 if v else 0):.1f}" height="14" rx="2"/>'
                   f'<text x="{lw + w + 4:.1f}" y="{y + 13}">{v:,}</text>')
    return "".join(out) + "</svg>"


def columns(rows, width=560, height=110):
    mx = max([v for _, v in rows] + [1])
    bw = width / max(len(rows), 1)
    out = [f'<svg viewBox="0 0 {width} {height + 16}" width="100%" role="img">']
    for i, (h, v) in enumerate(rows):
        bh = (height - 14) * v / mx
        out.append(f'<rect class="bar" x="{i * bw + 1:.1f}" y="{height - bh:.1f}" width="{bw - 2:.1f}" height="{bh:.1f}">'
                   f'<title>{e(h[-2:])}:00 UTC: {v}</title></rect>')
        if i % 3 == 0:
            out.append(f'<text x="{i * bw:.1f}" y="{height + 12}">{h[-2:]}</text>')
    out.append(f'<text x="0" y="10">max {mx}</text></svg>')
    return "".join(out)


def card(r):
    wl = ""
    if r["wl"]:
        ok, why = r["wl"]
        wl = f' <span class="tag {"ok" if ok else ""}" title="{e(why)}">{"whitelisted" if ok else "not whitelisted"}</span>'
    size = ""
    if r["kind"] == "pr":
        size = f' <span class="mut"><span class="add">+{r["additions"] or 0}</span> <span class="del">-{r["deletions"] or 0}</span></span>'
    docket = f' <span class="tag">{e(r["docket"])}</span>' if r["docket"] else ""
    det = []
    if r["reason"]:
        det.append(f'<div>{e(r["reason"])}</div>')
    if r["reference"]:
        det.append(f'<div class="mut">Reference: {e(r["reference"])}</div>')
    if r["kind"] == "pr":
        det.append(f'<div class="mut">{r["changed_files"] or 0} files, CI {e(r["ci_state"] or "?")}, {e(r["mergeable"] or "?")}</div>')
    return (f'<div class="card"><div class="top"><b>{item_link(r["repo"], r["number"], r["url"], r["kind"])}</b>'
            f'<span class="tag">{e(r["type_label"] or r["kind"])}</span>{size}'
            f'<span class="mut">{e(r["author"] or "?")}</span>{wl}{docket}</div>'
            f'<div class="mut">{e(r["title"] or "")}</div>'
            f'<div class="q">{e(r["note"] or "(no question recorded)")}</div>'
            f'<details><summary>Details</summary>{"".join(det) or "<div class=mut>No classification.</div>"}</details></div>')


def decisions_html(site, rows, with_repo_headers=True):
    out, last_repo, last_area = [], None, None
    for r in rows:
        if with_repo_headers and r["repo"] != last_repo:
            last_repo, last_area = r["repo"], None
            out.append(f'<h2><a href="{site.href("repo", r["repo"])}">{e(r["repo"])}</a></h2>')
        if r["area"] != last_area:
            last_area = r["area"]
            out.append(f'<h3>{e(r["area"] or "no area")}</h3>')
        out.append(card(r))
    return "".join(out) or '<p class="mut">No outstanding decisions.</p>'


def funnel_table(site, fun):
    head = ["open", "classified", "reviewed", "take/hold/close", "needs-decision", "batched", "merged/closed"]
    rows = []
    for repo, d in fun.items():
        rows.append(f'<tr><td><a href="{site.href("repo", repo)}">{e(repo)}</a></td>' + "".join(
            f'<td class="n">{v:,}</td>' for v in (d["open"], d["classified"], d["reviewed"], d["decided"],
                                                   d["needs-decision"], d["batched"], d["done"])) + "</tr>")
    tot = {k: sum(d[k] for d in fun.values()) for k in next(iter(fun.values()), {})}
    if tot:
        rows.append("<tr><th>Total</th>" + "".join(f'<th class="n">{tot[k]:,}</th>' for k in (
            "open", "classified", "reviewed", "decided", "needs-decision", "batched", "done")) + "</tr>")
    return ('<div class="scroll"><table><tr><th>Repo</th>' + "".join(f'<th class="n">{h}</th>' for h in head)
            + "</tr>" + "".join(rows) + "</table></div>")


def funnel_chart(fun):
    tot = {k: sum(d[k] for d in fun.values()) for k in next(iter(fun.values()), {})}
    if not tot:
        return ""
    return hbar([("open", tot["open"]), ("classified", tot["classified"]), ("reviewed", tot["reviewed"]),
                 ("take/hold/close", tot["decided"]), ("batched", tot["batched"]), ("merged/closed", tot["done"])])


def decisions_page(site, conn):
    rows = q.decisions(conn)
    n_repo = len({r["repo"] for r in rows})
    body = f'<h1>{len(rows)} decisions waiting</h1><p class="mut">{n_repo} repos. Newest question last within each area.</p>'
    return page(site, "Decisions", "decisions", body + decisions_html(site, rows))


def repo_page(site, conn, name):
    fun = q.funnel(conn, name)
    rows = q.decisions(conn, name)
    body = (f'<h1>{e(name)}</h1>{funnel_table(site, fun)}{funnel_chart(fun)}'
            f'<h2>{len(rows)} decisions</h2>{decisions_html(site, rows, False)}')
    return page(site, name, "progress", body)


def progress_page(site, conn):
    fun = q.funnel(conn)
    body = ("<h1>Progress</h1><h2>Org funnel</h2>" + funnel_chart(fun) + "<h2>Per repo</h2>" + funnel_table(site, fun)
            + "<h2>Open items by type</h2>" + hbar(q.by_type(conn))
            + "<h2>Open PRs by size</h2><p class='mut'>S up to 50 changed lines, M up to 300, L up to 1000, XL above.</p>"
            + hbar(q.by_size(conn)) + "<h2>Stage changes per hour, last 24 h (UTC)</h2>" + columns(q.per_hour(conn)))
    return page(site, "Progress", "progress", body)


SORTS = {"merged": lambda d: -d["merged"], "rate": lambda d: -d["rate"], "login": lambda d: d["login"].lower(),
         "last": lambda d: -(int((d["last_merge"] or "0")[:10].replace("-", "") or 0)),
         "open": lambda d: -d["open_prs"], "closed": lambda d: -d["closed_unmerged"]}


def contributors_page(site, conn, sort="merged", show_all=False):
    rows = list(whitelist.stats(conn).values())
    if not show_all:
        rows = [d for d in rows if d["whitelisted"] or d["override"]]
    rows.sort(key=lambda d: (SORTS.get(sort, SORTS["merged"])(d), d["login"].lower()))
    cols = [("login", "Login"), ("merged", "Merged"), ("closed", "Closed"), ("open", "Open"), ("rate", "Rate"), ("last", "Last merge")]
    head = "".join(f'<th{" class=n" if k not in ("login", "last") else ""}><a href="{site.href("contributors", sort=k, all=int(show_all))}">{n}</a></th>'
                   for k, n in cols) + "<th>Tier</th>" + ("" if site.static else "<th>Override</th>")
    body = []
    for d in rows:
        t = whitelist.tier(d)
        cls = "ok" if d["whitelisted"] else ("bad" if d["override"] == "deny" else "")
        cells = (f'<td>{e(d["login"])}<div class="mut">{e(", ".join(d["repos"]))}</div></td><td class="n">{d["merged"]}</td>'
                 f'<td class="n">{d["closed_unmerged"]}</td><td class="n">{d["open_prs"]}</td><td class="n">{d["rate"]:.0%}</td>'
                 f'<td>{e((d["last_merge"] or "-")[:10])}</td><td><span class="tag {cls}">{e(t)}</span></td>')
        if not site.static:
            lg = e(d["login"], quote=True)
            btns = "".join(f'<form method="post" action="/whitelist"><input type="hidden" name="login" value="{lg}">'
                           f'<input type="hidden" name="action" value="{a}"><button>{a}</button></form> '
                           for a in ("allow", "deny", "clear"))
            note = f'<div class="mut">{e(d["note"])}</div>' if d["note"] else ""
            cells += f"<td>{btns}{note}</td>"
        body.append(f"<tr>{cells}</tr>")
    toggle = f'<a href="{site.href("contributors", sort=sort, all=0 if show_all else 1)}">{"whitelisted only" if show_all else "show all"}</a>'
    m, r = whitelist.rule(conn)
    html = (f'<h1>Contributors</h1><p class="mut">Whitelisted: at least {m} merged and merge rate at least {r:.0%}; '
            f'an override wins. {len(rows)} shown, {toggle}.</p>'
            f'<div class="scroll"><table><tr>{head}</tr>{"".join(body)}</table></div>')
    return page(site, "Contributors", "contributors", html)


def cost_page(site, conn):
    rows = q.cost(conn)
    tr, ti, tt = [], 0, 0
    for d in rows:
        tok = (d["inp"] or 0) + (d["outp"] or 0)
        ti += d["items"] or 0
        tt += tok
        per = tok / d["items"] if d["items"] else 0
        tr.append(f'<tr><td>{e(d["stage"])}</td><td>{e(d["model"])}</td><td class="n">{d["items"] or 0:,}</td>'
                  f'<td class="n">{d["inp"] or 0:,}</td><td class="n">{d["outp"] or 0:,}</td>'
                  f'<td class="n">{(d["cr"] or 0):,}</td><td class="n">{(d["cw"] or 0):,}</td><td class="n">{per:,.0f}</td></tr>')
    by_stage = {}
    for d in rows:
        by_stage[d["stage"]] = by_stage.get(d["stage"], 0) + (d["inp"] or 0) + (d["outp"] or 0)
    html = (f'<h1>Cost</h1><p>Total {tt:,} input and output tokens over {ti:,} item runs.</p>'
            + hbar(sorted(by_stage.items(), key=lambda x: -x[1]))
            + '<h2>By stage and model</h2><div class="scroll"><table><tr><th>Stage</th><th>Model</th><th class="n">Items</th>'
              '<th class="n">Input</th><th class="n">Output</th><th class="n">Cache read</th><th class="n">Cache write</th>'
              '<th class="n">Tokens/item</th></tr>' + "".join(tr) + "</table></div>"
            + '<p class="mut">Tokens per item = (input + output) / items.</p>')
    return page(site, "Cost", "cost", html)
