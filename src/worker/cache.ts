// Shared crate cache and why it cannot poison later tasks.
//
// The shared cache is never mounted into a container. Each task gets its own
// CARGO_HOME (`/cache/cargo`), seeded by copying `registry/cache/*/*.crate`
// from the shared cache, and thrown away with the task. After the task, only
// regular `*.crate` files that the shared cache lacks are copied back: no
// extracted sources, index, config, binaries or git checkouts. A `.crate` file
// is verified by cargo against the checksum in the Cargo.lock of whatever task
// uses it, so a tampered file fails that task instead of running.
import { copyFileSync, constants, existsSync, lstatSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";

const INDEX_DIR = /^[A-Za-z0-9._-]+$/;
const CRATE_FILE = /^[A-Za-z0-9._+-]+\.crate$/;
const MAX_CRATE_BYTES = 100 * 1024 * 1024;

function crateFiles(root: string): { index: string; file: string; path: string }[] {
  const base = join(root, "registry", "cache");
  if (!existsSync(base)) return [];
  const out: { index: string; file: string; path: string }[] = [];
  for (const index of readdirSync(base)) {
    const dir = join(base, index);
    if (!INDEX_DIR.test(index) || !lstatSync(dir).isDirectory()) continue;
    for (const file of readdirSync(dir)) {
      const path = join(dir, file);
      const st = lstatSync(path);
      if (CRATE_FILE.test(file) && st.isFile() && st.size <= MAX_CRATE_BYTES) out.push({ index, file, path });
    }
  }
  return out;
}

function copyInto(from: { index: string; file: string; path: string }, toRoot: string): void {
  const dir = join(toRoot, "registry", "cache", from.index);
  const dest = join(dir, from.file);
  if (existsSync(dest)) return;
  mkdirSync(dir, { recursive: true });
  const tmp = `${dest}.tmp-${process.pid}`;
  copyFileSync(from.path, tmp, constants.COPYFILE_FICLONE);
  renameSync(tmp, dest);
}

/** Copies cached crates into a task's CARGO_HOME (`sharedDir` and `taskCargoHome` are host paths). */
export function seedCargoHome(sharedDir: string, taskCargoHome: string): void {
  mkdirSync(taskCargoHome, { recursive: true });
  for (const f of crateFiles(sharedDir)) copyInto(f, taskCargoHome);
}

/** Copies crates that the task downloaded into the shared cache. Returns how many are new. */
export function promoteCargoHome(taskCargoHome: string, sharedDir: string): number {
  let n = 0;
  for (const f of crateFiles(taskCargoHome)) {
    if (!existsSync(join(sharedDir, "registry", "cache", f.index, f.file))) n++;
    copyInto(f, sharedDir);
  }
  return n;
}
