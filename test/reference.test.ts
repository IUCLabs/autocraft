import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { askClaude, setRunner } from "../src/classify/run.ts";
import { connect } from "../src/db.ts";
import { SAMPLE_OPUS_PRS } from "../src/prompts/samples.ts";
import { importReference, referenceDir } from "../src/reference.ts";
import { trackRepo } from "../src/repos.ts";
import { REFERENCE_PATH, REPO_PATH } from "../src/sandbox/command.ts";
import { useTestAccount } from "./accounts-fixture.ts";
import { SCRATCH } from "./scratch.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "reference-test-"));
process.env.AUTOCRAFT_DB = join(dir, "data", "t.db");
mkdirSync(join(dir, "data"));
const db = connect();
trackRepo(db, "test", "app");

/** Builds a tar from a source tree; `extra` are extra tar arguments (for example a name transform). */
function tarOf(name: string, files: Record<string, string>, extra: string[] = [], links: Record<string, string> = {}): string {
  const src = join(dir, `src-${name}`);
  mkdirSync(src);
  for (const [f, text] of Object.entries(files)) writeFileSync(join(src, f), text);
  for (const [f, to] of Object.entries(links)) symlinkSync(to, join(src, f));
  const out = join(dir, `${name}.tar`);
  execFileSync("tar", ["-cf", out, "-C", src, ...extra, ...readdirSync(src)]);
  return out;
}
const leftovers = () => readdirSync(join(dir, "data", "reference")).filter((n) => n !== "app");

test("import installs a good archive and refuses unsafe ones without writing anything", () => {
  assert.equal(referenceDir("app"), undefined);
  const bad = [
    tarOf("dotdot", { "a.txt": "x" }, ["--transform", "s,^a.txt,../x.txt,"]),
    tarOf("abs", { "a.txt": "x" }, ["-P", "--transform", "s,^a.txt,/tmp/x.txt,"]),
    tarOf("link", {}, [], { "l.txt": "/etc/passwd" }),
    tarOf("ext", { "a.sh": "x" }),
  ];
  for (const t of bad) assert.throws(() => importReference(db, "test", "app", t), /not allowed|only|plain/, t);
  assert.equal(existsSync(join(dir, "data", "reference", "app")), false);
  assert.deepEqual(existsSync(join(dir, "data", "reference")) ? readdirSync(join(dir, "data", "reference")) : [], []);
  assert.throws(() => importReference(db, "test", "other", tarOf("good0", { "a.txt": "x" })), /not a tracked repo/);

  const good = tarOf("good", { "index.txt": "p0001.txt\tIntro\n", "p0001.txt": "page one\n", "guide.pdf": "%PDF-1.4" });
  assert.deepEqual(importReference(db, "test", "app", good), { files: 3, bytes: 16 + 9 + 8 });
  assert.equal(readFileSync(join(referenceDir("app")!, "p0001.txt"), "utf8"), "page one\n");
  assert.deepEqual(leftovers(), []);
  assert.throws(() => importReference(db, "test", "app", good), /--replace/);
  importReference(db, "test", "app", tarOf("good2", { "index.txt": "new\n" }), true);
  assert.deepEqual(readdirSync(referenceDir("app")!), ["index.txt"]);
  const row = db.prepare("SELECT target, details FROM audit WHERE action = 'reference-import' ORDER BY rowid DESC LIMIT 1").get() as { target: string; details: string };
  assert.equal(row.target, "app");
  assert.deepEqual(JSON.parse(row.details), { repo: "app", files: 1, bytes: 4 });
});

test("a sandboxed call mounts /reference only when the repo has a reference folder", async () => {
  const box = useTestAccount(db);
  const cfg = box.configDir + "t";
  mkdirSync(cfg, { recursive: true });
  writeFileSync(join(cfg, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "b", expiresAt: Date.now() + 6 * 3600_000 } }));
  process.env.AUTOCRAFT_CLAUDE_BIN = "/usr/bin/true";
  const calls: { args: string[]; stdin: string }[] = [];
  const restore = setRunner(async (_c, args, stdin) => { calls.push({ args, stdin: stdin ?? "" }); return { code: 0, stdout: JSON.stringify({ type: "result", result: "{}", num_turns: 1, usage: {} }), stderr: "" }; });
  try {
    const prs = SAMPLE_OPUS_PRS.map((p) => ({ ...p, repo_dir: REPO_PATH }));
    const co = join(dir, "co");
    mkdirSync(co, { recursive: true });
    await askClaude("review.opus", "opus", prs, db, { checkout: co });
    await askClaude("review.opus", "opus", prs, db, { checkout: co, reference: referenceDir("app") });
    const bind = (a: string[]) => a.join(" ").includes(` ${REFERENCE_PATH}`);
    assert.equal(bind(calls[0]!.args), false);
    assert.equal(calls[0]!.stdin.includes(REFERENCE_PATH), false);
    assert.ok(calls[0]!.stdin.includes("docs/gaps.md"));
    assert.ok(calls[1]!.args.join(" ").includes(`--ro-bind ${referenceDir("app")} ${REFERENCE_PATH}`));
    assert.ok(calls[1]!.stdin.includes(`at ${REFERENCE_PATH} (read-only`));
  } finally {
    restore();
    delete process.env.AUTOCRAFT_CLAUDE_BIN;
  }
});
