"""Read-only queries behind the dashboard pages."""
from craft_auto import whitelist

LATEST_STAGE = """
(SELECT repo, number, stage, at, actor, note, docket FROM (
   SELECT *, ROW_NUMBER() OVER (PARTITION BY repo, number ORDER BY at DESC, rowid DESC) rn FROM stages)
 WHERE rn = 1)"""
LATEST_CLASS = """
(SELECT repo, number, type_label, want, area, reason, reference FROM (
   SELECT *, ROW_NUMBER() OVER (PARTITION BY repo, number ORDER BY at DESC, run_id DESC) rn FROM classifications)
 WHERE rn = 1)"""

SIZE_CASE = """CASE WHEN i.kind != 'pr' THEN NULL WHEN i.additions + i.deletions <= 50 THEN 'S'
 WHEN i.additions + i.deletions <= 300 THEN 'M' WHEN i.additions + i.deletions <= 1000 THEN 'L' ELSE 'XL' END"""
SIZE_ORDER = ["S", "M", "L", "XL"]


def decisions(conn, repo=None):
    where, args = ("AND s.repo = ?", (repo,)) if repo else ("", ())
    rows = [dict(r) for r in conn.execute(f"""
        SELECT s.repo, s.number, s.note, s.docket, s.at, i.kind, i.title, i.url, i.author, i.additions,
               i.deletions, i.changed_files, i.state, i.ci_state, i.mergeable,
               c.type_label, c.area, c.reason, c.reference, c.want
        FROM {LATEST_STAGE} s JOIN items i USING (repo, number) LEFT JOIN {LATEST_CLASS} c USING (repo, number)
        WHERE s.stage = 'needs-decision' {where} ORDER BY s.repo, c.area, s.at""", args)]
    wl = {}
    for r in rows:
        a = r["author"]
        if a and a not in wl:
            wl[a] = whitelist.is_whitelisted(conn, a)
        r["wl"] = wl.get(a)
    return rows


FUNNEL_STEPS = ["open", "classified", "reviewed", "decided", "batched", "done"]


def funnel(conn, repo=None):
    """Per repo counts of open items that reached each step, plus items merged or closed by us."""
    where, args = ("WHERE repo = ?", (repo,)) if repo else ("", ())
    out = {}
    def row(r):
        return out.setdefault(r, dict.fromkeys(FUNNEL_STEPS, 0) | {"take": 0, "hold": 0, "close": 0, "needs-decision": 0})
    for r in conn.execute(f"SELECT repo, COUNT(*) n FROM items {where + (' AND' if where else 'WHERE')} state='OPEN' GROUP BY repo", args):
        row(r["repo"])["open"] = r["n"]
    for r in conn.execute(f"SELECT repo, COUNT(DISTINCT number) n FROM classifications {where} GROUP BY repo", args):
        row(r["repo"])["classified"] = r["n"]
    for r in conn.execute(f"SELECT repo, stage, COUNT(DISTINCT number) n FROM stages {where} GROUP BY repo, stage", args):
        d = row(r["repo"])
        if r["stage"] == "reviewed":
            d["reviewed"] = r["n"]
        elif r["stage"] == "batched":
            d["batched"] = r["n"]
        elif r["stage"] in ("merged", "closed", "fixed-by-us"):
            d["done"] += r["n"]
    for r in conn.execute(f"SELECT repo, stage, COUNT(*) n FROM {LATEST_STAGE} {where} GROUP BY repo, stage", args):
        d = row(r["repo"])
        if r["stage"] in ("take", "hold", "close", "needs-decision"):
            d[r["stage"]] = r["n"]
            if r["stage"] != "needs-decision":
                d["decided"] += r["n"]
    return dict(sorted(out.items()))


def repos(conn):
    return [r["name"] for r in conn.execute("SELECT name FROM repos ORDER BY name")]


def by_type(conn):
    return [tuple(r) for r in conn.execute(f"""
        SELECT COALESCE(c.type_label, 'unclassified'), COUNT(*) FROM items i
        LEFT JOIN {LATEST_CLASS} c USING (repo, number) WHERE i.state = 'OPEN' GROUP BY 1 ORDER BY 2 DESC""")]


def by_size(conn):
    d = {r[0]: r[1] for r in conn.execute(
        f"SELECT {SIZE_CASE} sz, COUNT(*) FROM items i WHERE i.kind='pr' AND i.state='OPEN' GROUP BY sz")}
    return [(s, d.get(s, 0)) for s in SIZE_ORDER]


def per_hour(conn):
    """Stage rows per hour for the last 24 h, oldest first."""
    d = {r[0]: r[1] for r in conn.execute(
        "SELECT strftime('%Y-%m-%dT%H', at) h, COUNT(*) FROM stages "
        "WHERE at >= strftime('%Y-%m-%dT%H:%M:%S', 'now', '-24 hours') GROUP BY h")}
    hours = [r[0] for r in conn.execute(
        "WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<23) "
        "SELECT strftime('%Y-%m-%dT%H', 'now', '-' || (23-i) || ' hours') FROM n")]
    return [(h, d.get(h, 0)) for h in hours]


def cost(conn):
    by = [dict(r) for r in conn.execute("""
        SELECT COALESCE(stage,'?') stage, COALESCE(model,'?') model, SUM(items) items,
          SUM(input_tokens) inp, SUM(output_tokens) outp, SUM(cache_read_tokens) cr, SUM(cache_write_tokens) cw
        FROM token_usage GROUP BY 1, 2 ORDER BY 1, 2""")]
    return by
