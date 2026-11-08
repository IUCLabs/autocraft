// A chain of symlinks must not let an archive write outside the destination.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import { extractTar } from "../src/worker/tarball.ts";
import { makeTarGz } from "./tar-util.ts";
import { SCRATCH } from "./scratch.ts";

test("extractTar refuses entries below a symlink created earlier in the archive", async () => {
  mkdirSync(SCRATCH, { recursive: true });
  const top = mkdtempSync(join(SCRATCH, "tar-symlink-"));
  try {
    const dest = join(top, "mid", "dest");
    mkdirSync(dest, { recursive: true });
    const tar = gunzipSync(
      makeTarGz([
        { name: "deep/a/b/" },
        { name: "deep/a/b/s", type: "2", linkname: "../../.." },
        { name: "deep/a/b/s/x", type: "2", linkname: "../.." },
        { name: "deep/a/b/s/x/ESCAPED/y", type: "2", linkname: "z" },
      ]),
    );
    await assert.rejects(extractTar((async function* () { yield tar; })(), dest, undefined, 0), /symlink/);
    assert.equal(existsSync(join(top, "ESCAPED")), false);
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
});
