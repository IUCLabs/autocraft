#!/usr/bin/env node
// Fault-injection proxy between helpers and the dashboard (no dependencies).
//   node scripts/loadtest/proxy.mjs --listen 8801 --target http://127.0.0.1:8994 --control 8802 [--log file.jsonl] [--rate502 0.1] ...
// Faults per request, each decided independently in this order: down, reset, 502, 429, then added latency. A "before"
// fault drops the request before the dashboard sees it; an "after" fault forwards it, waits for the dashboard's answer and
// then drops or replaces it (the case where the server acted and the helper never learns of it). `afterShare` is the share of
// reset and 502 faults that are "after".
// Control port (JSON): GET /state; POST /set {rate502, rateReset, rate429, retryAfter, latMin, latMax, afterShare};
// POST /down?s=N (refuse connections for N seconds; the listener closes and reopens); POST /up.
// Every finished request is one line in the log: { t, route, method, status, upMs, heldMs, totalMs, fault }. `upMs` is the
// dashboard's own time from the forwarded request to the end of its answer, less the time a long-polling claim waited for a
// call (`heldMs`, the reply's X-Held-Ms); `fault` is empty for an untouched request.
import { createServer, request } from "node:http";
import { appendFileSync } from "node:fs";

/** @param {{ listen: number, target: string, control?: number, log?: string, faults?: object, quiet?: boolean }} o */
export function startProxy(o) {
  const target = new URL(o.target);
  const cfg = { rate502: 0, rateReset: 0, rate429: 0, retryAfter: 2, latMin: 0, latMax: 0, afterShare: 0.5, ...o.faults };
  let downUntil = 0, downTimer = null, listening = false;
  const stats = { requests: 0, faults: {} };
  const sockets = new Set();
  const log = (rec) => { if (o.log) appendFileSync(o.log, `${JSON.stringify(rec)}\n`); };
  const routeOf = (p) => p.replace(/\?.*$/, "").replace(/\/(\d+)(?=\/|$)/g, "/:n");
  const roll = (p) => Math.random() < p;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const proxy = createServer(async (req, res) => {
    const t0 = Date.now();
    const route = routeOf(req.url ?? "/");
    const done = (status, fault, upMs, heldMs = 0) => {
      stats.requests++;
      if (fault) stats.faults[fault] = (stats.faults[fault] ?? 0) + 1;
      log({ t: t0, route, method: req.method, status, upMs, heldMs, totalMs: Date.now() - t0, fault: fault ?? "" });
    };
    const reset = (fault, upMs) => { done(0, fault, upMs); req.socket.destroy(); };
    const after = roll(cfg.afterShare);
    // Buffer the body so a "before" fault can drop the request without a half-sent upload.
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    if (roll(cfg.rateReset) && !after) return reset("reset-before");
    if (roll(cfg.rate502) && !after) { res.writeHead(502, { "content-type": "text/plain" }).end("Bad Gateway"); return done(502, "502-before"); }
    if (roll(cfg.rate429)) { res.writeHead(429, { "retry-after": String(cfg.retryAfter), "content-type": "text/plain" }).end("Too Many Requests"); return done(429, "429"); }
    const lat = cfg.latMax > 0 ? cfg.latMin + Math.random() * (cfg.latMax - cfg.latMin) : 0;
    if (lat) await sleep(lat);
    const up0 = Date.now();
    const headers = { ...req.headers, connection: "close" };
    const fwd = request({ host: target.hostname, port: target.port, method: req.method, path: req.url, headers }, (ur) => {
      const parts = [];
      ur.on("data", (c) => parts.push(c));
      ur.on("end", () => {
        // A long-polling claim waits on purpose; its wait (X-Held-Ms) is not the dashboard's latency.
        const heldMs = Number(ur.headers["x-held-ms"] ?? 0) || 0;
        const upMs = Math.max(0, Date.now() - up0 - heldMs);
        const dropAfter = after && roll(cfg.rateReset), failAfter = after && roll(cfg.rate502);
        if (dropAfter) return reset("reset-after", upMs);
        if (failAfter) { res.writeHead(502, { "content-type": "text/plain" }).end("Bad Gateway"); return done(502, "502-after", upMs); }
        const h = { ...ur.headers };
        delete h.connection; delete h["transfer-encoding"];
        res.writeHead(ur.statusCode ?? 502, h).end(Buffer.concat(parts));
        done(ur.statusCode ?? 502, lat ? "latency" : "", upMs, heldMs);
      });
      ur.on("error", () => { res.destroy(); done(0, "upstream-error", Date.now() - up0); });
    });
    fwd.on("error", () => {
      if (res.destroyed) return done(0, "client-gone", Date.now() - up0);
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" }).end("upstream unreachable");
      done(502, "upstream-down", Date.now() - up0);
    });
    // The helper gave up (its own timeout): the dashboard sees the connection close, as it would without the proxy.
    res.on("close", () => { if (!res.writableEnded) fwd.destroy(); });
    fwd.end(body);
  });
  proxy.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  proxy.keepAliveTimeout = 5000;

  const open = () => new Promise((r) => { if (listening) return r(); proxy.listen(o.listen, "127.0.0.1", () => { listening = true; r(); }); });
  const closeListener = () => new Promise((r) => { if (!listening) return r(); listening = false; proxy.close(() => r()); for (const s of sockets) s.destroy(); });
  const down = async (seconds) => {
    downUntil = Date.now() + seconds * 1000;
    clearTimeout(downTimer);
    await closeListener();
    downTimer = setTimeout(() => { downUntil = 0; void open(); }, seconds * 1000);
  };
  const up = async () => { clearTimeout(downTimer); downUntil = 0; await open(); };

  const control = o.control === undefined ? null : createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    const send = (b) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(b));
    if (u.pathname === "/state") return send({ cfg, down: downUntil > Date.now() ? Math.ceil((downUntil - Date.now()) / 1000) : 0, stats });
    if (u.pathname === "/set" && req.method === "POST") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      Object.assign(cfg, JSON.parse(Buffer.concat(chunks).toString() || "{}"));
      return send({ cfg });
    }
    if (u.pathname === "/down") { await down(Number(u.searchParams.get("s") ?? 30)); return send({ down: Number(u.searchParams.get("s") ?? 30) }); }
    if (u.pathname === "/up") { await up(); return send({ down: 0 }); }
    res.writeHead(404).end();
  });
  return {
    cfg, stats, set: (f) => Object.assign(cfg, f), down, up,
    start: async () => { await open(); if (control) await new Promise((r) => control.listen(o.control, "127.0.0.1", r)); },
    stop: async () => { clearTimeout(downTimer); await closeListener(); control?.close(); },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const a = process.argv.slice(2);
  const opt = (n, d) => { const i = a.indexOf(`--${n}`); return i >= 0 ? a[i + 1] : d; };
  const p = startProxy({
    listen: Number(opt("listen", 8801)), target: opt("target", "http://127.0.0.1:8994"), control: Number(opt("control", 8802)), log: opt("log"),
    faults: { rate502: Number(opt("rate502", 0)), rateReset: Number(opt("rate-reset", 0)), rate429: Number(opt("rate429", 0)), latMin: Number(opt("lat-min", 0)), latMax: Number(opt("lat-max", 0)) },
  });
  await p.start();
  console.log(`proxy ${opt("listen", 8801)} -> ${opt("target", "http://127.0.0.1:8994")}, control ${opt("control", 8802)}`);
}
