// The shared warm snapshot store: upload from one worker, download into another, key checks, interrupted upload.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, test } from "node:test";
import { parseWorkerConfig } from "../src/worker/config.ts";
import { createStore, parseStoreConfig } from "../src/worker/store.ts";
import { copyWarm, storeWarm } from "../src/worker/warm.ts";
import { downloadWarm, uploadWarm } from "../src/worker/warm-sync.ts";
import { SCRATCH } from "./scratch.ts";

mkdirSync(SCRATCH, { recursive: true });
const root = mkdtempSync(join(SCRATCH, "warm-store-"));
after(() => rmSync(root, { recursive: true, force: true }));

const READ = "r".repeat(20);
const WRITE = "w".repeat(20);

test("a main build's target dir reaches another worker; bad keys and interrupted uploads change nothing", async () => {
  const store = createStore(parseStoreConfig({ dir: join(root, "store"), readKey: READ, writeKey: WRITE }));
  await new Promise<void>((r) => store.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(store.address() as AddressInfo).port}`;
  const worker = (name: string, warmStore: object) =>
    parseWorkerConfig({ coordinatorUrl: "http://x", keyFile: "/k", workDir: join(root, name, "w"), warmDir: join(root, name, "warm"), warmStore });
  const a = worker("a", { url, readKey: READ, writeKey: WRITE });
  const b = worker("b", { url, readKey: READ });
  const bad = worker("c", { url, readKey: "x".repeat(20) });
  const say = (m: string) => log.push(m);
  const log: string[] = [];
  try {
    const target = join(root, "a", "target");
    mkdirSync(join(target, "debug"), { recursive: true });
    writeFileSync(join(target, "debug", "lib.rlib"), "built");
    const sha1 = "a".repeat(40);
    await storeWarm(a, "repo", sha1, target);
    await uploadWarm(a, "repo", sha1, say);

    // A wrong read key gets nothing and the task is not failed.
    await downloadWarm(bad, "repo", say);
    assert.equal(await copyWarm(bad, "repo", join(root, "c-out")), false);
    assert.match(log.join("\n"), /lookup answered 401/);
    // A read key cannot write.
    const put = await fetch(`${url}/store/repo?commit=${sha1}`, { method: "PUT", headers: { authorization: `Bearer ${READ}` }, body: "x" });
    assert.equal(put.status, 401);

    // Another worker downloads, unpacks and copies it.
    await downloadWarm(b, "repo", say);
    const out = join(root, "b-out");
    mkdirSync(out);
    assert.equal(await copyWarm(b, "repo", out), true);
    assert.equal(readFileSync(join(out, "debug", "lib.rlib"), "utf8"), "built");

    // An upload cut off mid-body leaves the previous snapshot in place.
    const before = await (await fetch(`${url}/store/repo`, { headers: { authorization: `Bearer ${READ}` } })).json();
    await new Promise<void>((resolve) => {
      const req = request(`${url}/store/repo?commit=${"b".repeat(40)}`, { method: "PUT", headers: { authorization: `Bearer ${WRITE}`, "content-length": "1000" } });
      req.on("error", () => {});
      req.write("partial");
      setTimeout(() => {
        req.destroy();
        setTimeout(resolve, 100);
      }, 50);
    });
    const after2 = await (await fetch(`${url}/store/repo`, { headers: { authorization: `Bearer ${READ}` } })).json();
    assert.deepEqual(after2, before);
    assert.equal(readdirSync(join(root, "store")).filter((f) => f.startsWith(".up-") && f.endsWith(".tmp")).length, 0);
  } finally {
    await new Promise((r) => store.close(r));
  }
});
