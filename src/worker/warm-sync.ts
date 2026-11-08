// Worker side of the shared snapshot store: runs in the trusted worker process
// on the host. The build container only ever sees the copied target dir.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PassThrough, Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { freeDiskGb, type WorkerConfig } from "./config.ts";
import { dirOf, readRecord, storeWarm } from "./warm.ts";

type Remote = { commit: string; size: number; sha256: string; bytes?: number };
type Say = (msg: string) => void;

let zstdOk: Promise<boolean> | undefined;
const hasZstd = () => (zstdOk ??= new Promise<boolean>((r) => execFile("zstd", ["--version"], (err) => r(!err))));

const inflight = new Map<string, Promise<void>>();

/** Makes the local warm dir match the store's snapshot for `key`. Never throws. */
export function downloadWarm(cfg: WorkerConfig, key: string, say: Say): Promise<void> {
  const s = cfg.warmStore;
  if (!s) return Promise.resolve();
  const running = inflight.get(key);
  if (running) return running;
  const p = (async () => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), s.timeoutSec * 1000);
    const procs: ChildProcess[] = [];
    ac.signal.addEventListener("abort", () => procs.forEach((c) => c.kill("SIGKILL")), { once: true });
    const stage = join(cfg.warmDir, `.dl-${key}-${process.pid}-${Date.now()}`);
    try {
      if (!(await hasZstd())) return say("warm store: zstd is missing, download skipped");
      const head = await fetch(`${s.url}/store/${key}`, { headers: { authorization: `Bearer ${s.readKey}` }, signal: ac.signal });
      if (head.status === 404) return;
      if (!head.ok) return say(`warm store: lookup answered ${head.status}`);
      const rec = (await head.json()) as Remote;
      if (readRecord(cfg, key)?.commit === rec.commit) return;
      const raw = rec.bytes ?? rec.size * 4;
      if (raw > cfg.warmMaxGb * 1024 ** 3) return say("warm store: snapshot is larger than warmMaxGb, skipped");
      mkdirSync(cfg.warmDir, { recursive: true });
      if (freeDiskGb(cfg.warmDir) * 1024 ** 3 < raw + cfg.limits.minFreeDiskGb * 1024 ** 3) return say("warm store: not enough free disk, skipped");
      const res = await fetch(`${s.url}/store/${key}/blob`, { headers: { authorization: `Bearer ${s.readKey}` }, signal: ac.signal });
      if (!res.ok || !res.body) return say(`warm store: download answered ${res.status}`);
      mkdirSync(stage, { recursive: true });
      const zstd = spawn("zstd", ["-dc"], { stdio: ["pipe", "pipe", "ignore"] });
      const tar = spawn("tar", ["-x", "--no-same-owner", "-C", stage], { stdio: ["pipe", "ignore", "ignore"] });
      procs.push(zstd, tar);
      const exits = [zstd, tar].map((c) => new Promise<number | null>((r) => c.on("close", (code) => r(code))));
      for (const c of [zstd, tar]) c.on("error", () => ac.abort());
      zstd.stdout!.pipe(tar.stdin!);
      const hash = createHash("sha256");
      const tap = new Transform({ transform(chunk: Buffer, _e, cb) { hash.update(chunk); cb(null, chunk); } });
      await pipeline(Readable.fromWeb(res.body as never), tap, zstd.stdin!);
      const codes = await Promise.all(exits);
      if (codes.some((c) => c !== 0)) throw new Error("unpack failed");
      if (hash.digest("hex") !== rec.sha256) throw new Error("sha256 mismatch");
      await storeWarm(cfg, key, rec.commit, stage);
      say(`warm store: downloaded snapshot of ${rec.commit.slice(0, 12)}`);
    } catch (e) {
      say(`warm store: download failed: ${ac.signal.aborted ? "timed out" : (e as Error).message}`);
    } finally {
      clearTimeout(timer);
      procs.forEach((c) => c.kill("SIGKILL"));
      rmSync(stage, { recursive: true, force: true });
    }
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** Uploads the local warm dir for `key` (just stored by a trusted main build). Never throws. */
export async function uploadWarm(cfg: WorkerConfig, key: string, commit: string, say: Say): Promise<void> {
  const s = cfg.warmStore;
  if (!s?.writeKey) return;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), s.timeoutSec * 1000);
  const procs: ChildProcess[] = [];
  try {
    if (!(await hasZstd())) return say("warm store: zstd is missing, upload skipped");
    const bytes = readRecord(cfg, key)?.bytes ?? 0;
    const tar = spawn("tar", ["-C", dirOf(cfg, key), "-cf", "-", "."], { stdio: ["ignore", "pipe", "ignore"] });
    const zstd = spawn("zstd", ["-T0", "-3", "-c"], { stdio: ["pipe", "pipe", "ignore"] });
    procs.push(tar, zstd);
    tar.stdout!.pipe(zstd.stdin!);
    // A failed tar or zstd errors the body stream, which aborts the request: the store never commits a partial snapshot.
    const body = new PassThrough();
    zstd.stdout!.pipe(body, { end: false });
    const closed = [tar, zstd].map((c) => new Promise<number | null>((r) => c.on("close", (code) => r(code))));
    void Promise.all(closed).then((codes) => codes.every((c) => c === 0) && body.end());
    let failed = false;
    const fail = (why: string) => {
      if (failed) return;
      failed = true;
      body.destroy(new Error(why));
    };
    tar.on("close", (code) => code !== 0 && fail(`tar exited ${code}`));
    zstd.on("close", (code) => code !== 0 && fail(`zstd exited ${code}`));
    for (const c of procs) c.on("error", (e) => fail(e.message));
    ac.signal.addEventListener("abort", () => fail("timed out"), { once: true });
    const res = await fetch(`${s.url}/store/${key}?commit=${commit}&bytes=${bytes}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${s.writeKey}`, "content-type": "application/zstd" },
      body: Readable.toWeb(body) as never,
      duplex: "half",
      signal: ac.signal,
    } as RequestInit);
    say(res.ok ? `warm store: uploaded snapshot of ${commit.slice(0, 12)}` : `warm store: upload answered ${res.status}`);
  } catch (e) {
    say(`warm store: upload failed: ${ac.signal.aborted ? "timed out" : (e as Error).message}`);
  } finally {
    clearTimeout(timer);
    procs.forEach((c) => c.kill("SIGKILL"));
  }
}
