import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Readable } from "node:stream";
import { archiveOf, type TaskLease } from "../src/remote/tools.ts";
import { SCRATCH } from "./scratch.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "remote-archive-"));
process.env.AUTOCRAFT_FIXUP_DIR = join(dir, "fixups");
process.env.AUTOCRAFT_DIFF_CACHE = join(dir, "cache", "diffs");

const read = async (s: Readable): Promise<Buffer> => {
  const parts: Buffer[] = [];
  for await (const c of s) parts.push(c as Buffer);
  return Buffer.concat(parts);
};

describe("tarball archives", () => {
  it("serves git archive output, caches it per commit and refuses commits the bundle does not list", async () => {
    const repo = join(process.env.AUTOCRAFT_FIXUP_DIR!, "r");
    mkdirSync(repo, { recursive: true });
    const git = (...a: string[]): string => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8" }).trim();
    git("init", "-q", "--bare", ".");
    const work = join(dir, "work");
    execFileSync("git", ["init", "-q", work]);
    writeFileSync(join(work, "f.txt"), "hello");
    const wg = (...a: string[]): string => execFileSync("git", ["-C", work, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8" }).trim();
    wg("add", "."); wg("commit", "-qm", "c");
    const sha = wg("rev-parse", "HEAD");
    wg("push", "-q", repo, "HEAD:refs/heads/main");
    const lease = { mounts: [{ kind: "tarball", repo: "r", sha }] } as unknown as TaskLease;
    assert.equal(await archiveOf(lease, "r", "0".repeat(40)), null);
    const first = await read((await archiveOf(lease, "r", sha))!);
    assert.match(first.toString("latin1"), /f\.txt/);
    await new Promise((r) => setTimeout(r, 200));
    const cached = readdirSync(join(dir, "cache", "archives"));
    assert.deepEqual(cached, [`r@${sha}.tar`]);
    assert.ok(existsSync(join(dir, "cache", "archives", cached[0]!)));
    const second = await read((await archiveOf(lease, "r", sha))!);
    assert.ok(first.equals(second));
  });
});
