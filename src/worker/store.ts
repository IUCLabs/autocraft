// Shared snapshot store for warm target dirs (the "cache node"). Holds one
// `.tar.zst` snapshot per repo key plus a JSON record. Reads need the read
// key, writes the write key. Plain HTTP: run it behind TLS or on a private network.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isAbsolute, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { WARM_KEY } from "./warm.ts";

export type StoreConfig = { listen: string; dir: string; maxGb: number; maxUploadGb: number; readKey: string; writeKey: string };
export type StoreRecord = { commit: string; size: number; sha256: string; stored: number; bytes?: number; lastRead: number };

export function parseStoreConfig(raw: unknown): StoreConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("config: expected a JSON object");
  const o = raw as Record<string, unknown>;
  const num = (n: string, def: number) => {
    const v = o[n] ?? def;
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > 100_000) throw new Error(`config: ${n} must be a positive number`);
    return v;
  };
  const strOf = (n: string, def?: string) => {
    const v = o[n] ?? def;
    if (typeof v !== "string" || !v) throw new Error(`config: ${n} is required`);
    return v;
  };
  const dir = strOf("dir");
  if (!isAbsolute(dir)) throw new Error("config: dir must be an absolute path");
  const listen = strOf("listen", "127.0.0.1:8990");
  if (!/^[^\s]+:\d{1,5}$/.test(listen)) throw new Error("config: listen must be host:port");
  const readKey = strOf("readKey");
  const writeKey = strOf("writeKey");
  if (readKey.length < 16 || writeKey.length < 16) throw new Error("config: keys must be at least 16 characters");
  if (readKey === writeKey) throw new Error("config: readKey and writeKey must differ");
  return { listen, dir, maxGb: num("maxGb", 200), maxUploadGb: num("maxUploadGb", 20), readKey, writeKey };
}

const digest = (s: string) => createHash("sha256").update(s).digest();
const sameKey = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));
const COMMIT = /^[0-9a-f]{7,64}$/;

export function createStore(cfg: StoreConfig): Server {
  mkdirSync(cfg.dir, { recursive: true, mode: 0o700 });
  for (const e of readdirSync(cfg.dir)) if (e.startsWith(".up-")) rmSync(join(cfg.dir, e), { force: true });
  const recPath = (k: string) => join(cfg.dir, `${k}.json`);
  // The blob name carries its hash, so renaming the record is the single commit point.
  const blobPath = (k: string, sha: string) => join(cfg.dir, `${k}.${sha}.tar.zst`);

  const readRec = (k: string): StoreRecord | null => {
    try {
      const r = JSON.parse(readFileSync(recPath(k), "utf8")) as StoreRecord;
      return typeof r.sha256 === "string" && /^[0-9a-f]{64}$/.test(r.sha256) && existsSync(blobPath(k, r.sha256)) ? r : null;
    } catch {
      return null;
    }
  };
  const writeRec = (k: string, r: StoreRecord) => {
    const tmp = join(cfg.dir, `.up-${k}-${randomBytes(4).toString("hex")}.json`);
    writeFileSync(tmp, JSON.stringify(r));
    renameSync(tmp, recPath(k));
  };
  const keys = () => readdirSync(cfg.dir).filter((e) => e.endsWith(".json") && !e.startsWith(".")).map((e) => e.slice(0, -5)).filter((k) => WARM_KEY.test(k));
  const evict = (keep: string) => {
    const cap = cfg.maxGb * 1024 ** 3;
    for (;;) {
      const all = keys().map((k) => ({ k, r: readRec(k) })).filter((x): x is { k: string; r: StoreRecord } => x.r !== null);
      const total = all.reduce((s, x) => s + x.r.size, 0);
      const victim = all.filter((x) => x.k !== keep).sort((a, b) => a.r.lastRead - b.r.lastRead)[0];
      if (total <= cap || !victim) return;
      rmSync(recPath(victim.k), { force: true });
      rmSync(blobPath(victim.k, victim.r.sha256), { force: true });
    }
  };
  // Drops blobs no record points to (replaced snapshots).
  const sweep = (k: string, keepSha: string) => {
    for (const e of readdirSync(cfg.dir)) if (e.startsWith(`${k}.`) && e.endsWith(".tar.zst") && e !== `${k}.${keepSha}.tar.zst`) rmSync(join(cfg.dir, e), { force: true });
  };

  const send = (res: ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  async function put(req: IncomingMessage, res: ServerResponse, key: string, q: URLSearchParams) {
    const commit = q.get("commit") ?? "";
    if (!COMMIT.test(commit)) return send(res, 400, { error: "commit must be a hex sha" });
    const bytes = Number(q.get("bytes"));
    const limit = cfg.maxUploadGb * 1024 ** 3;
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > limit) return send(res, 413, { error: "body too large" });
    const tmp = join(cfg.dir, `.up-${key}-${randomBytes(6).toString("hex")}.tmp`);
    const hash = createHash("sha256");
    let size = 0;
    const tap = new Transform({
      transform(chunk: Buffer, _e, cb) {
        size += chunk.length;
        if (size > limit) return cb(new Error("body too large"));
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    try {
      await pipeline(req, tap, createWriteStream(tmp, { mode: 0o600 }));
      if (!req.complete || size === 0) throw new Error("incomplete upload");
    } catch (e) {
      rmSync(tmp, { force: true });
      if (!res.writableEnded && !res.destroyed) send(res, (e as Error).message === "body too large" ? 413 : 400, { error: (e as Error).message });
      return;
    }
    const sha256 = hash.digest("hex");
    renameSync(tmp, blobPath(key, sha256));
    const rec: StoreRecord = { commit, size, sha256, stored: Date.now(), bytes: Number.isFinite(bytes) && bytes > 0 ? bytes : undefined, lastRead: Date.now() };
    writeRec(key, rec);
    sweep(key, sha256);
    evict(key);
    send(res, 200, rec);
  }

  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const m = /^\/store\/([^/]+)(\/blob)?$/.exec(url.pathname);
    if (!m || !WARM_KEY.test(m[1]!)) return send(res, 404, { error: "not found" });
    const [, key, blob] = m as unknown as [string, string, string | undefined];
    const auth = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ""))?.[1] ?? "";
    const write = req.method === "PUT";
    if (!auth || !(sameKey(auth, cfg.writeKey) || (!write && sameKey(auth, cfg.readKey)))) return send(res, 401, { error: "unauthorized" });
    if (write && !blob) {
      void put(req, res, key, url.searchParams).catch(() => res.destroy());
      return;
    }
    if (req.method !== "GET") return send(res, 405, { error: "method not allowed" });
    const rec = readRec(key);
    if (!rec) return send(res, 404, { error: "no snapshot" });
    if (!blob) return send(res, 200, rec);
    writeRec(key, { ...rec, lastRead: Date.now() });
    res.writeHead(200, { "content-type": "application/zstd", "content-length": statSync(blobPath(key, rec.sha256)).size, "x-sha256": rec.sha256 });
    createReadStream(blobPath(key, rec.sha256)).on("error", () => res.destroy()).pipe(res);
  });
}

export async function storeServe(configPath: string): Promise<void> {
  const cfg = parseStoreConfig(JSON.parse(readFileSync(configPath, "utf8")));
  const server = createStore(cfg);
  const i = cfg.listen.lastIndexOf(":");
  await new Promise<void>((resolve) => server.listen(Number(cfg.listen.slice(i + 1)), cfg.listen.slice(0, i), resolve));
  console.log(`${new Date().toISOString()} snapshot store listening on ${cfg.listen}`);
  await new Promise<void>((resolve) => {
    for (const s of ["SIGINT", "SIGTERM"] as const) process.on(s, () => server.close(() => resolve()));
  });
}
