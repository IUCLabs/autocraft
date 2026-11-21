// AUTOCRAFT_DEFAULT_OWNER: bare repo names, the sync's org listing and search, and the image proxy follow the configured owner.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { SCRATCH } from "./scratch.ts";

process.env.AUTOCRAFT_DEFAULT_OWNER = "IUCLabs";
const { DEFAULT_OWNER, ownerOf, resetOwners, splitSlug } = await import("../src/owners.ts");
const { connect } = await import("../src/db.ts");
const { listAll, trackRepo } = await import("../src/repos.ts");
const { runSync } = await import("../src/mirror.ts");
const { allowedImage } = await import("../src/dash/server/images.ts");

test("bare repo names belong to the configured owner", () => {
  resetOwners();
  const db = connect(join(mkdtempSync(join(SCRATCH, "default-owner-")), "o.db"));
  assert.equal(DEFAULT_OWNER, "IUCLabs");
  assert.deepEqual(splitSlug("autocraft"), { owner: "IUCLabs", name: "autocraft" });
  trackRepo(db, "t", "autocraft");
  assert.equal(ownerOf("autocraft"), "IUCLabs");
  assert.equal(listAll(db).find((r) => r.name === "autocraft")?.owner, "IUCLabs");
});

test("an owner typed in another case is stored as the configured owner", () => {
  resetOwners();
  const db = connect(join(mkdtempSync(join(SCRATCH, "default-owner-")), "o.db"));
  trackRepo(db, "t", "iuclabs/foo");
  assert.equal(ownerOf("foo"), "IUCLabs");
});

test("sync searches and lists the configured owner", async () => {
  resetOwners();
  const db = connect(join(mkdtempSync(join(SCRATCH, "default-owner-")), "o.db"));
  db.exec("DELETE FROM tracked_repos");
  db.exec("INSERT INTO tracked_repos VALUES ('autocraft','t','x',1)");
  db.exec("INSERT INTO repos (name, synced_at, high_water, reconciled_at) VALUES ('autocraft','2026-11-02T09:00:00Z','2026-11-02T09:00:00Z','2026-11-02T09:00:00Z')");
  db.exec("INSERT INTO settings VALUES ('org_high_water','2026-11-02T09:30:00Z'),('search_catchup_at','2999-01-01T00:00:00Z')");
  const searches: string[] = [];
  const listed: unknown[] = [];
  const client = {
    spent: 0, remaining: 4000 as number | null,
    async query(q: string, v: Record<string, unknown>) {
      if (q.includes("search(")) {
        searches.push(String(v.q));
        return { search: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } };
      }
      if ("login" in v) {
        listed.push(v.login);
        return { repositoryOwner: { repositories: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } };
      }
      return { repository: null };
    },
  };
  await runSync(db, client, { only: [], all: false, full: false, perRepo: false }, new Date("2026-11-02T10:05:00Z"));
  assert.ok(searches.length && searches.every((q) => q.includes("org:IUCLabs")));
  assert.deepEqual(listed, ["IUCLabs"]);
});

test("the image proxy serves raw files of the configured owner only", () => {
  assert.ok(allowedImage("https://raw.githubusercontent.com/IUCLabs/autocraft/main/a.png"));
  assert.ok(allowedImage("https://raw.githubusercontent.com/iucLabs/autocraft/main/a.png"));
  assert.equal(allowedImage("https://raw.githubusercontent.com/storytold/autocraft/main/a.png"), null);
});

const ownerIn = (env: Record<string, string>) =>
  spawnSync(process.execPath, ["--input-type=module", "-e", `import(${JSON.stringify(new URL("../src/owners.ts", import.meta.url).href)}).then((m) => console.log(m.DEFAULT_OWNER))`], {
    env: { ...process.env, AUTOCRAFT_DEFAULT_OWNER: "", ...env }, encoding: "utf8",
  });

test("the default owner is storytold, and an invalid owner is refused", () => {
  assert.equal(ownerIn({}).stdout.trim(), "storytold");
  const bad = ownerIn({ AUTOCRAFT_DEFAULT_OWNER: "x'; DROP" });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /AUTOCRAFT_DEFAULT_OWNER is not a GitHub owner/);
});
