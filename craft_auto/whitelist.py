"""Contributor whitelist: automatic tier from merge history, owner overrides on top."""
import json
from datetime import datetime, timezone

from craft_auto.db import connect

STATS_SQL = """
SELECT author AS login,
  SUM(state='MERGED') AS merged,
  SUM(state='CLOSED') AS closed_unmerged,
  SUM(state='OPEN') AS open_prs,
  MAX(merged_at) AS last_merge,
  GROUP_CONCAT(DISTINCT repo) AS repos
FROM items WHERE kind='pr' AND author IS NOT NULL AND author != ''
{where} GROUP BY author
"""


def rule(conn) -> tuple[int, float]:
    s = dict(conn.execute("SELECT key, value FROM settings"))
    return int(s.get("whitelist_min_merged", 5)), float(s.get("whitelist_min_merge_rate", 0.6))


def _row(r) -> dict:
    d = dict(r)
    done = (d["merged"] or 0) + (d["closed_unmerged"] or 0)
    d["rate"] = (d["merged"] or 0) / done if done else 0.0
    d["repos"] = sorted((d["repos"] or "").split(",")) if d["repos"] else []
    return d


def _empty(login: str) -> dict:
    return {"login": login, "merged": 0, "closed_unmerged": 0, "open_prs": 0,
            "last_merge": None, "repos": [], "rate": 0.0}


def stats(conn, login: str | None = None) -> dict[str, dict]:
    """Per-author PR stats keyed by login, with tier, override and note filled in."""
    where, args = ("AND author = ?", (login,)) if login else ("", ())
    out = {r["login"]: _row(r) for r in conn.execute(STATS_SQL.format(where=where), args)}
    min_merged, min_rate = rule(conn)
    ov = {r["login"]: r for r in conn.execute("SELECT * FROM whitelist_overrides")}
    for name in set(ov) if not login else ({login} & set(ov)):
        out.setdefault(name, _empty(name))
    for name, d in out.items():
        auto = d["merged"] >= min_merged and d["rate"] >= min_rate
        o = ov.get(name)
        d["override"] = o["status"] if o else None
        d["note"] = o["note"] if o else None
        d["override_by"] = o["by"] if o else None
        d["override_at"] = o["at"] if o else None
        d["auto"] = auto
        d["whitelisted"] = (o["status"] == "allow") if o else auto
    return out


def is_whitelisted(conn, login: str) -> tuple[bool, str]:
    d = stats(conn, login).get(login) or _empty(login) | {
        "override": None, "auto": False, "whitelisted": False}
    if d["override"]:
        return d["whitelisted"], f"owner override: {d['override']}"
    min_merged, min_rate = rule(conn)
    done = d["merged"] + d["closed_unmerged"]
    base = f"{d['merged']} merged of {done} decided PRs (rate {d['rate']:.0%})"
    need = f"needs >= {min_merged} merged and >= {min_rate:.0%}"
    return d["auto"], f"{base}; {'meets' if d['auto'] else 'below'} the rule ({need})"


def set_override(conn, login: str, status: str | None, note: str | None = None, by: str = "cli"):
    if status is None:
        conn.execute("DELETE FROM whitelist_overrides WHERE login=?", (login,))
    else:
        conn.execute("INSERT OR REPLACE INTO whitelist_overrides VALUES (?,?,?,?,?)",
                     (login, status, note, by, datetime.now(timezone.utc).isoformat(timespec="seconds")))
    conn.commit()


def tier(d: dict) -> str:
    if d["override"]:
        return f"{d['override']} (override)"
    return "whitelisted" if d["auto"] else "-"


def _line(d: dict) -> str:
    return (f"{d['login']:<24} {tier(d):<18} merged {d['merged']:>3}  closed {d['closed_unmerged']:>3}  "
            f"open {d['open_prs']:>3}  rate {d['rate']:>4.0%}  last {(d['last_merge'] or '-')[:10]}  "
            f"{','.join(d['repos'])}")


def cmd_list(args):
    conn = connect()
    rows = stats(conn).values()
    if args.repo:
        rows = [d for d in rows if args.repo in d["repos"]]
    if not args.all:
        rows = [d for d in rows if d["whitelisted"] or d["override"]]
    for d in sorted(rows, key=lambda d: (-d["merged"], d["login"])):
        print(_line(d))


def cmd_show(args):
    conn = connect()
    d = stats(conn, args.login).get(args.login)
    if not d:
        print(f"no PRs or override for {args.login}")
        return
    print(_line(d))
    print("whitelisted:", is_whitelisted(conn, args.login))
    if d["override"]:
        print(f"override: {d['override']} by {d['override_by']} at {d['override_at']} note: {d['note'] or ''}")
    for r in conn.execute("SELECT repo, number, state, title FROM items WHERE kind='pr' AND author=? "
                          "ORDER BY updated_at DESC LIMIT 10", (args.login,)):
        print(f"  {r['repo']}#{r['number']} {r['state']:<6} {r['title']}")


def _set(status):
    def run(args):
        conn = connect()
        set_override(conn, args.login, status, getattr(args, "note", None))
        print(f"{args.login}: {status or 'override cleared'}")
    return run


def cmd_rule(args):
    conn = connect()
    if args.min_merged is not None:
        conn.execute("INSERT OR REPLACE INTO settings VALUES ('whitelist_min_merged', ?)", (str(args.min_merged),))
    if args.min_rate is not None:
        conn.execute("INSERT OR REPLACE INTO settings VALUES ('whitelist_min_merge_rate', ?)", (str(args.min_rate),))
    conn.commit()
    m, r = rule(conn)
    print(f"whitelisted when merged >= {m} and merge rate >= {r}")


def register(subparsers):
    p = subparsers.add_parser("whitelist", help="contributor whitelist")
    sub = p.add_subparsers(dest="wcmd", required=True)
    a = sub.add_parser("list"); a.add_argument("--all", action="store_true"); a.add_argument("--repo")
    a.set_defaults(func=cmd_list)
    a = sub.add_parser("show"); a.add_argument("login"); a.set_defaults(func=cmd_show)
    for name, status in (("allow", "allow"), ("deny", "deny")):
        a = sub.add_parser(name); a.add_argument("login"); a.add_argument("--note")
        a.set_defaults(func=_set(status))
    a = sub.add_parser("clear"); a.add_argument("login"); a.set_defaults(func=_set(None))
    a = sub.add_parser("rule"); a.add_argument("--min-merged", type=int)
    a.add_argument("--min-rate", type=float); a.set_defaults(func=cmd_rule)
