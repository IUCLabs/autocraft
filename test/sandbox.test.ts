import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { setRunner, askClaude, type Runner } from "../src/classify/run.ts";
import { connect } from "../src/db.ts";
import { claudeArgs, promptsReport } from "../src/prompts/index.ts";
import { SAMPLE_OPUS_PRS } from "../src/prompts/samples.ts";
import { buildCheckout, DEFAULT_CAPS, pruneCheckouts, safePath } from "../src/sandbox/checkout.ts";
import { REPO_PATH, sandboxCommand } from "../src/sandbox/command.ts";
import { useTestAccount } from "./accounts-fixture.ts";

const SCRATCH = join(homedir(), ".cache/craft-automation-scratch");
mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "sandbox-test-"));

const spec = { claudeBin: "/h/claude-bin", checkout: "/h/checkout", credentials: "/h/acct/.credentials.json", claudeArgs: ["-p", "--tools", "Read"] };
const pairs = (args: string[], flag: string) => args.flatMap((a, i) => (a === flag ? [args.slice(i + 1, i + 3).join(" ")] : []));

describe("sandbox command", () => {
  const { cmd, args } = sandboxCommand(spec);

  test("binds only claude, the system, the checkout read-only and one credentials file; nothing of the host home", () => {
    assert.equal(cmd, "/usr/bin/bwrap");
    assert.deepEqual(pairs(args, "--ro-bind"), ["/usr /usr", "/etc/ssl /etc/ssl", "/etc/resolv.conf /etc/resolv.conf", "/h/claude-bin /opt/claude/claude", `/h/checkout ${REPO_PATH}`]);
    assert.deepEqual(pairs(args, "--bind"), ["/h/acct/.credentials.json /home/sandbox/.claude/.credentials.json"]);
    assert.deepEqual(pairs(args, "--tmpfs").map((t) => t.split(" ")[0]), ["/tmp", "/home/sandbox", "/home/sandbox/.claude", "/work"]);
    assert.ok(!args.some((a) => a === "--dev-bind" || a === "--bind-try" || a.startsWith("/home/user") || a === homedir()));
  });

  test("new namespaces except the network, dies with the parent, clean environment", () => {
    for (const f of ["--unshare-all", "--share-net", "--die-with-parent", "--new-session", "--clearenv"]) assert.ok(args.includes(f), f);
    assert.equal(args.indexOf("--clearenv") < args.indexOf("--setenv"), true);
    assert.deepEqual(pairs(args, "--setenv").sort(), ["CLAUDE_CONFIG_DIR /home/sandbox/.claude", "DISABLE_AUTOUPDATER 1", "HOME /home/sandbox", "LANG C.UTF-8", "PATH /usr/bin"]);
    assert.deepEqual(args.slice(args.indexOf("--chdir"), args.indexOf("--chdir") + 2), ["--chdir", "/work"]);
  });

  test("claude runs last with its own arguments", () => {
    assert.deepEqual(args.slice(-4), ["/opt/claude/claude", "-p", "--tools", "Read"]);
  });

  test("Opus review: read-only tools, deny by default, allow rule for the checkout only, turn cap", () => {
    const a = claudeArgs("review.opus", "opus", true);
    const at = (f: string) => a[a.indexOf(f) + 1];
    assert.equal(at("--tools"), "Read,Grep,Glob");
    assert.equal(at("--allowedTools"), "Read(//work/repo/**)");
    assert.equal(at("--permission-mode"), "dontAsk");
    assert.equal(at("--permission-prompts"), "none");
    assert.equal(at("--max-turns"), "20");
    for (const f of ["--restricted", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"]) assert.ok(a.includes(f), f);
    assert.throws(() => claudeArgs("review.sonnet", "sonnet", true), /no sandbox mode/);
    const plain = claudeArgs("review.opus", "opus");
    assert.equal(plain[plain.indexOf("--tools") + 1], "");
  });

  test("the Prompts page shows tools, max turns and the sandbox", () => {
    const p = promptsReport(null).prompts.find((x) => x.id === "review.opus")!;
    const rows = Object.fromEntries(p.settings.map((s) => [s.label, s.value]));
    assert.match(rows["Tools"]!, /Read, Grep, Glob/);
    assert.equal(rows["Max turns"], "20");
    assert.match(rows["Sandbox"]!, /bubblewrap/);
    assert.match(p.command, /^\/usr\/bin\/bwrap --unshare-all/);
    assert.match(p.example, /repository at \/work\/repo/);
    assert.equal(promptsReport(null).prompts.find((x) => x.id === "review.sonnet")!.settings.find((s) => s.label === "Tools")!.value, "None");
  });
});

describe("checkout", () => {
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" };
  const g = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, env: gitEnv, encoding: "utf8" }).trim();
  const work = join(dir, "work");
  mkdirSync(join(work, "src"), { recursive: true });
  g(work, "init", "-q");
  writeFileSync(join(work, "src/lib.rs"), "fn main() {}\n");
  writeFileSync(join(work, "run.sh"), "#!/bin/sh\n");
  execFileSync("chmod", ["+x", join(work, "run.sh")]);
  writeFileSync(join(work, "big.bin"), Buffer.alloc(3 * 1024 * 1024));
  symlinkSync("/etc/passwd", join(work, "link"));
  g(work, "add", "-A");
  g(work, "update-index", "--add", "--cacheinfo", "160000,1111111111111111111111111111111111111111,sub");
  g(work, "commit", "-qm", "c");
  const sha = g(work, "rev-parse", "HEAD");
  const bare = join(dir, "bare.git");
  g(dir, "clone", "-q", "--bare", work, bare);

  test("only regular small files are copied: no symlink, submodule or oversized file; modes drop to plain files", async () => {
    const dest = join(dir, "out", "app", sha);
    const r = await buildCheckout(bare, sha, dest);
    assert.ok(r.ok);
    assert.equal(readFileSync(join(dest, "src/lib.rs"), "utf8"), "fn main() {}\n");
    assert.ok(existsSync(join(dest, "run.sh")));
    assert.equal(lstatSync(join(dest, "run.sh")).mode & 0o111, 0);
    for (const gone of ["link", "big.bin", "sub"]) assert.equal(existsSync(join(dest, gone)), false, gone);
    assert.equal((await buildCheckout(bare, sha, dest)).ok, true, "reused");
  });

  test("a tree over the caps is refused", async () => {
    const r = await buildCheckout(bare, sha, join(dir, "out", "app", "small"), { ...DEFAULT_CAPS, maxFiles: 1 });
    assert.deepEqual(r.ok, false);
    assert.equal((await buildCheckout(bare, "not-a-sha", join(dir, "out", "x"))).ok, false);
  });

  test("unsafe paths are rejected", () => {
    for (const p of ["../x", "a/../b", "/abs", ".git/config", "a/.GIT/x", "a//b", ""]) assert.equal(safePath(p), false, p);
    assert.equal(safePath("src/.github/ci.yml"), true);
  });

  test("old unfinished and unused checkouts are pruned", () => {
    const root = join(dir, "prune");
    mkdirSync(join(root, "app", "aaa"), { recursive: true });
    mkdirSync(join(root, "app", "bbb"), { recursive: true });
    const old = new Date(Date.now() - 3 * 86400_000);
    utimesSync(join(root, "app", "aaa"), old, old);
    assert.equal(pruneCheckouts(root, 86400_000), 1);
    assert.equal(existsSync(join(root, "app", "bbb")), true);
  });
});

const bwrapOk = existsSync("/usr/bin/bwrap") && spawnSync("/usr/bin/bwrap", ["--unshare-all", "--ro-bind", "/usr", "/usr", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64", "/usr/bin/true"]).status === 0;

describe("bubblewrap (no model)", { skip: !bwrapOk && "bwrap unavailable" }, () => {
  const checkout = join(dir, "co");
  mkdirSync(checkout, { recursive: true });
  writeFileSync(join(checkout, "a.txt"), "in repo\n");
  const secret = join(dir, "secret.txt");
  writeFileSync(secret, "host secret\n");
  const creds = join(dir, "credentials.json");
  writeFileSync(creds, "{}");
  const sh = (script: string) => {
    const c = sandboxCommand({ claudeBin: "/usr/bin/sh", checkout, credentials: creds, claudeArgs: ["-c", script] });
    return spawnSync(c.cmd, c.args, { encoding: "utf8", env: { PATH: process.env.PATH! } });
  };

  test("sees the checkout read-only and nothing else of the host", () => {
    assert.equal(sh(`cat ${REPO_PATH}/a.txt`).stdout, "in repo\n");
    assert.notEqual(sh(`echo x > ${REPO_PATH}/b.txt`).status, 0);
    assert.notEqual(sh(`cat ${secret}`).status, 0);
    assert.notEqual(sh(`ls ${homedir()}`).status, 0);
    assert.equal(sh("ls /home").stdout.trim(), "sandbox");
    assert.equal(sh("ls -A /home/sandbox/.claude").stdout.trim(), ".credentials.json");
    assert.equal(sh("env | grep -c HOME").stdout.trim(), "1");
  });
});

describe("askClaude in tool mode", () => {
  const db = connect(join(dir, "t.db"));
  const box = useTestAccount(db);

  test("runs claude inside bwrap with the sandbox arguments, records turns, removes token-like text", async () => {
    const cfg = box.configDir + "t";
    mkdirSync(cfg, { recursive: true });
    writeFileSync(join(cfg, ".credentials.json"), "{}");
    process.env.CRAFT_AUTO_CLAUDE_BIN = "/usr/bin/true";
    const calls: { cmd: string; args: string[] }[] = [];
    const leak = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4";
    const fake: Runner = async (cmd, args) => {
      calls.push({ cmd, args });
      return { code: 0, stdout: JSON.stringify({ type: "result", result: `{"ref":"x","reason":"${leak}"}`, num_turns: 4, usage: {} }), stderr: "" };
    };
    const restore = setRunner(fake);
    try {
      const r = await askClaude("review.opus", "opus", SAMPLE_OPUS_PRS, db, { checkout: join(dir, "co") });
      assert.equal(calls[0]!.cmd, "/usr/bin/bwrap");
      assert.ok(calls[0]!.args.join(" ").includes(`${join(dir, "co")} ${REPO_PATH}`));
      assert.deepEqual(calls[0]!.args.slice(-claudeArgs("review.opus", "opus", true).length), claudeArgs("review.opus", "opus", true));
      assert.equal(r!.turns, 4);
      assert.ok(!r!.text.includes(leak));
      const run = db.prepare("SELECT summary FROM agent_runs ORDER BY rowid DESC LIMIT 1").get() as { summary: string } | undefined;
      assert.match(run?.summary ?? "", /4 turns/);
      // Without a checkout the same prompt runs tool-free through plain claude.
      await askClaude("review.opus", "opus", SAMPLE_OPUS_PRS, db);
      assert.equal(calls[1]!.cmd, "claude");
      assert.deepEqual(calls[1]!.args, claudeArgs("review.opus", "opus"));
    } finally {
      restore();
      delete process.env.CRAFT_AUTO_CLAUDE_BIN;
    }
  });
});
