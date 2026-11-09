import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { connect } from "../src/db.ts";
import { ScreenshotConfigError, deleteConfig, getConfig, paramValueError, parseScreenshotConfig, putConfig } from "../src/verify/screenshot-config.ts";
import { SCRATCH } from "./scratch.ts";

mkdirSync(SCRATCH, { recursive: true });
const fresh = () => connect(join(mkdtempSync(join(SCRATCH, "sc-")), "t.db"));

const good = () => ({
  package: "photocraft-ui-egui", example: "snapshot", driver: "args", size: "1440x900", ui_paths: ["crates/ui*/**"],
  commands: { snap: { doc: "Render the main window.", params: { size: { enum: ["1440x900", "1024x768"] } }, argv: ["--out", "{out}", "--size", "{size}"], capture: true } },
});
const mutate = (f: (c: ReturnType<typeof good>) => void) => {
  const c = good();
  f(c);
  return parseScreenshotConfig(c);
};

test("a valid setup parses; unknown placeholders, shell characters and validator-less params are rejected", () => {
  assert.ok("ok" in parseScreenshotConfig(good()));
  assert.ok("ok" in parseScreenshotConfig(JSON.stringify(good())));
  assert.match((mutate((c) => { c.commands.snap.argv.push("{nope}"); }) as { error: string }).error, /unknown placeholder \{nope\}/);
  assert.ok("error" in mutate((c) => { c.package = "x; rm -rf /"; }));
  assert.ok("error" in mutate((c) => { c.package = "-p"; }));
  assert.ok("error" in mutate((c) => { (c.commands.snap.params as Record<string, unknown>).size = {}; }));
  assert.ok("error" in mutate((c) => { (c.commands.snap.params as Record<string, unknown>).size = { re: "^(a+)+$" }; }));
  assert.ok("error" in mutate((c) => { c.commands.snap.capture = false; }));
  assert.ok("error" in mutate((c) => { c.ui_paths = ["../x"]; }));
});

test("put, get and delete are audited; a bad config is not stored; arguments are checked against their validators", () => {
  const db = fresh();
  assert.throws(() => putConfig(db, "op", "app", { ...good(), driver: "nope" }), ScreenshotConfigError);
  assert.equal(getConfig(db, "app"), null);
  const c = putConfig(db, "op", "app", good());
  assert.equal(getConfig(db, "app")?.commands.snap?.capture, true);
  assert.equal(getConfig(db, "app")?.updatedBy, c.updatedBy);
  assert.equal(deleteConfig(db, "op", "app"), true);
  assert.equal(getConfig(db, "app"), null);
  assert.equal((db.prepare("SELECT count(*) AS n FROM audit WHERE action = 'screenshot-config'").get() as { n: number }).n, 2);
  assert.equal(paramValueError({ enum: ["a"] }, "a"), null);
  assert.notEqual(paramValueError({ re: "^[a-z-]+$" }, "-x"), null);
  assert.notEqual(paramValueError({ int: [1, 3] }, 4), null);
});
