// Repos of other owners: tracking owner/name, the owner each write and query uses, storytold's repos unchanged.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { connect } from "../src/db.ts";
import { ghClosePr } from "../src/github/write.ts";
import { mainCiQuery, mainCiVars } from "../src/mainci/index.ts";
import { ownerOf, resetOwners, trackedOwners } from "../src/owners.ts";
import { RepoError, trackRepo } from "../src/repos.ts";
import { G } from "./guarded.ts";
import { SCRATCH } from "./scratch.ts";

test("a tracked aiongg-sandbox repo is written to under its own owner; storytold repos are unchanged", async () => {
  resetOwners();
  const db = connect(join(mkdtempSync(join(SCRATCH, "owners-")), "o.db"));
  assert.ok(trackRepo(db, "t", "aiongg-sandbox/autocraft-sandbox"));
  trackRepo(db, "t", "designcraft");
  assert.equal(ownerOf("autocraft-sandbox"), "aiongg-sandbox");
  assert.equal(ownerOf("designcraft"), "storytold");
  assert.deepEqual(trackedOwners(db), ["aiongg-sandbox", "storytold"]);
  assert.throws(() => trackRepo(db, "t", "other/designcraft"), RepoError);
  assert.throws(() => trackRepo(db, "t", "bad owner/x"), RepoError);

  const seen: string[][] = [];
  const exec = async (_c: string, args: string[]) => { seen.push(args); return { code: 0, stdout: "", stderr: "" }; };
  const w = { db, login: "t" };
  await ghClosePr(w, G("autocraft-sandbox"), exec, { repo: "autocraft-sandbox", number: 3 }, { by: "fixed" }, "x");
  await ghClosePr(w, G("designcraft"), exec, { repo: "designcraft", number: 4 }, { by: "fixed" }, "x");
  assert.equal(seen[0]![seen[0]!.indexOf("--repo") + 1], "aiongg-sandbox/autocraft-sandbox");
  assert.equal(seen[1]![seen[1]!.indexOf("--repo") + 1], "storytold/designcraft");

  assert.deepEqual(mainCiVars(["autocraft-sandbox", "designcraft"]), { o0: "aiongg-sandbox", o1: "storytold" });
  assert.match(mainCiQuery(["a", "b"]), /^query\(\$o0: String!, \$o1: String!\)/);
});
