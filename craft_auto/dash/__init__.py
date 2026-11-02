"""Backlog dashboard: `craft-auto dash serve` and `craft-auto dash export`."""
import sqlite3
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from craft_auto import whitelist
from craft_auto.db import connect, db_path
from craft_auto.dash import queries, render

PAGES = {"": render.decisions_page, "progress": render.progress_page, "cost": render.cost_page}


def read_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(f"file:{db_path()}?mode=ro", uri=True, timeout=30)
    conn.row_factory = sqlite3.Row
    return conn


def route(site, conn, path: str, qs: dict) -> str | None:
    path = path.strip("/")
    if path in PAGES:
        return PAGES[path](site, conn)
    if path == "contributors":
        return render.contributors_page(site, conn, qs.get("sort", ["merged"])[0], qs.get("all", ["0"])[0] == "1")
    if path.startswith("repo/"):
        name = unquote(path[5:])
        if name in queries.repos(conn):
            return render.repo_page(site, conn, name)
    return None


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body="", ctype="text/html; charset=utf-8", headers=()):
        data = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        for k, v in headers:
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        u = urlparse(self.path)
        try:
            conn = read_conn()
            try:
                html = route(render.Site(False), conn, u.path, parse_qs(u.query))
            finally:
                conn.close()
        except Exception as ex:
            return self._send(500, f"error: {ex}", "text/plain")
        self._send(200 if html else 404, html or "not found")

    def do_POST(self):
        if urlparse(self.path).path != "/whitelist":
            return self._send(404, "not found")
        n = int(self.headers.get("Content-Length") or 0)
        f = parse_qs(self.rfile.read(n).decode())
        login, action = f.get("login", [""])[0], f.get("action", [""])[0]
        if not login or action not in ("allow", "deny", "clear"):
            return self._send(400, "bad request", "text/plain")
        conn = connect()
        try:
            whitelist.set_override(conn, login, None if action == "clear" else action, by="dash")
        finally:
            conn.close()
        self._send(303, "", headers=[("Location", self.headers.get("Referer") or "/contributors")])

    def log_message(self, fmt, *args):
        pass


def cmd_serve(args):
    connect().close()  # make sure the schema exists
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"dashboard on http://{args.host}:{args.port}/")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


def cmd_export(args):
    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    site = render.Site(True)
    conn = read_conn()
    pages = [("index.html", render.decisions_page(site, conn)), ("progress.html", render.progress_page(site, conn)),
             ("cost.html", render.cost_page(site, conn)),
             ("contributors.html", render.contributors_page(site, conn))]
    pages += [(f"repo-{name}.html", render.repo_page(site, conn, name)) for name in queries.repos(conn)]
    for name, html in pages:
        (out / name).write_text(html)
    print(f"wrote {len(pages)} pages to {out}")


def register(subparsers):
    p = subparsers.add_parser("dash", help="dashboard")
    sub = p.add_subparsers(dest="dcmd", required=True)
    s = sub.add_parser("serve")
    s.add_argument("--port", type=int, default=8993)
    s.add_argument("--host", default="127.0.0.1")
    s.set_defaults(func=cmd_serve)
    x = sub.add_parser("export")
    x.add_argument("out_dir")
    x.set_defaults(func=cmd_export)
