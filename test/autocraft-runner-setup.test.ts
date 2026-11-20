import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as helper from "../worker/autocraft.mjs";
import type * as H from "../worker/autocraft.mjs";

const base: H.SetupFacts = {
  platform: "linux", root: false, pkg: "apt", missing: [], sandbox: "ok", sandboxError: "", userns: false, bwrapProfile: false,
  harness: "claude", harnessBin: true, claudeBin: "/home/u/.local/bin/claude", claudeDir: null, otherClaude: null, harnessLogin: "set",
  loggedIn: true, loggedInTo: "https://artcraft.build", server: null, me: "autocraft",
};
const steps = (f: Partial<H.SetupFacts>) => helper.setupSteps({ ...base, ...f });
const ids = (f: Partial<H.SetupFacts>) => steps(f).map((s) => s.id);

test("a machine with everything needs no step", () => {
  assert.deepEqual(steps({}), []);
});

test("Windows gets one step that names WSL and no command", () => {
  const s = steps({ platform: "win32", missing: ["git"], harnessBin: false, loggedIn: false });
  assert.deepEqual(s.map((x) => x.id), ["platform"]);
  assert.equal(s[0]!.cmd, undefined);
  assert.match(s[0]!.fix, /WSL/);
});

test("missing packages are installed with the system's package manager, with sudo unless root", () => {
  assert.equal(steps({ missing: ["bubblewrap", "git"] })[0]!.cmd, "sudo apt-get install -y bubblewrap git");
  assert.equal(steps({ missing: ["bubblewrap"], pkg: "dnf", root: true })[0]!.cmd, "dnf install -y bubblewrap");
  assert.equal(steps({ missing: ["bubblewrap"], pkg: "pacman" })[0]!.cmd, "sudo pacman -S --needed --noconfirm bubblewrap");
  // No known package manager: the step names the packages and runs nothing.
  const none = steps({ missing: ["bubblewrap"], pkg: null })[0]!;
  assert.equal(none.cmd, undefined);
  assert.match(none.problem, /bubblewrap/);
  assert.equal(steps({ platform: "darwin", missing: ["git"], pkg: null })[0]!.cmd, "xcode-select --install");
});

test("a sandbox blocked by AppArmor gets a bwrap-only profile; another cause or an existing profile only shows the error", () => {
  const s = steps({ sandbox: "failed", sandboxError: "bwrap: setting up uid map: Permission denied", userns: true })[0]!;
  assert.equal(s.id, "apparmor");
  assert.match(s.cmd!, /^sudo sh -c '.*' sh 'abi <abi\/4\.0>,' /);
  assert.match(s.cmd!, /'profile bwrap \/usr\/bin\/bwrap flags=\(unconfined\) \{'/);
  assert.equal(steps({ sandbox: "failed", userns: true, root: true })[0]!.cmd!.startsWith("sh -c "), true);
  assert.deepEqual(steps({ sandbox: "failed", userns: true, bwrapProfile: true }).map((x) => [x.id, x.cmd]), [["sandbox", undefined]]);
  assert.deepEqual(steps({ sandbox: "failed", userns: false }).map((x) => [x.id, x.cmd]), [["sandbox", undefined]]);
});

test("a missing claude is installed with the native installer; a snap or VS Code copy is named but not used", () => {
  const s = steps({ harnessBin: false, otherClaude: "VS Code's own Claude Code" })[0]!;
  assert.equal(s.cmd, "curl -fsSL https://claude.ai/install.sh | bash");
  assert.match(s.problem, /VS Code's own Claude Code cannot be used/);
  // Codex: the audited versions, no command.
  const c = steps({ harness: "codex", harnessBin: false })[0]!;
  assert.equal(c.cmd, undefined);
  assert.match(c.fix, new RegExp(helper.CODEX_AUDITED[0]!.replace(".", "\\.")));
});

test("the harness login: sign in first, then take over the login of the platform", () => {
  assert.deepEqual(steps({ harnessLogin: "none" }).map((s) => [s.id, s.cmd]), [["claude-signin", "/home/u/.local/bin/claude"]]);
  // A claude outside PATH and a config directory that is not the default one are both used for the sign-in.
  assert.equal(steps({ harnessLogin: "none", claudeBin: "/opt/my claude/claude", claudeDir: "/data/claude" })[0]!.cmd, "CLAUDE_CONFIG_DIR=/data/claude '/opt/my claude/claude'");
  assert.equal(steps({ harnessLogin: "available" })[0]!.cmd, "autocraft harness claude --config-dir");
  assert.equal(steps({ harnessLogin: "available", platform: "darwin" })[0]!.cmd, "autocraft harness claude --keychain");
  assert.equal(steps({ harness: "codex", harnessLogin: "none" })[0]!.cmd, "autocraft harness codex");
  // No harness binary: no login step yet.
  assert.deepEqual(ids({ harnessBin: false, harnessLogin: "none" }), ["harness-bin"]);
});

test("the dashboard login runs only with a URL given to setup, quoted for the shell", () => {
  assert.equal(steps({ loggedIn: false, server: "https://artcraft.build" })[0]!.cmd, "autocraft login https://artcraft.build");
  assert.equal(steps({ loggedIn: false })[0]!.cmd, undefined);
  assert.equal(steps({ loggedIn: false, server: "https://x.example/a b" })[0]!.cmd, "autocraft login 'https://x.example/a b'");
  // Logged in to another dashboard than the one setup was given: offered, and the step says what it replaces.
  const other = steps({ loggedIn: false, loggedInTo: "https://a.example", server: "https://b.example" })[0]!;
  assert.equal(other.cmd, "autocraft login https://b.example");
  assert.match(other.problem, /logged in to https:\/\/a\.example, not to https:\/\/b\.example/);
  assert.match(other.fix, /replaces the login to https:\/\/a\.example/);
});

test("steps come in the order they must be fixed", () => {
  assert.deepEqual(ids({ missing: ["bubblewrap"], harnessBin: false, loggedIn: false, server: "https://artcraft.build" }), ["packages", "harness-bin", "login"]);
});

test("setup refuses unknown flags and more than one URL", async () => {
  const errors: string[] = [];
  const err = console.error;
  console.error = (m: string) => { errors.push(m); };
  try {
    assert.equal(await helper.main(["setup", "--force"]), 2);
    assert.equal(await helper.main(["setup", "https://a.example", "https://b.example"]), 2);
    assert.equal(await helper.main(["setup", "http://example.com"]), 1);
  } finally { console.error = err; }
  assert.match(errors.join("\n"), /usage: autocraft setup/);
  assert.match(errors.join("\n"), /https/);
});

// The AppArmor step's command, run against a scratch file instead of /etc/apparmor.d/bwrap, with `true` or `false` as apparmor_parser.
const profileRun = (parser: "true" | "false", setup?: (file: string) => void) => {
  const dir = mkdtempSync(join(tmpdir(), "apparmor-")).replace(/\\/g, "/");
  const file = `${dir}/bwrap`;
  setup?.(file);
  const cmd = steps({ sandbox: "failed", userns: true, root: true })[0]!.cmd!.replaceAll("/etc/apparmor.d/bwrap", file).replace("apparmor_parser", parser);
  const r = spawnSync("sh", ["-c", cmd], { encoding: "utf8" });
  const left = readdirSync(dir);
  const text = existsSync(file) ? readFileSync(file, "utf8") : null;
  rmSync(dir, { recursive: true, force: true });
  return { status: r.status, left, text };
};
const shOk = spawnSync("sh", ["-c", "command -v mktemp ln >/dev/null"]).status === 0;

test("the AppArmor profile is written whole and loaded; one that does not load is removed again", { skip: !shOk && "no sh" }, () => {
  const ok = profileRun("true");
  assert.equal(ok.status, 0);
  assert.equal(ok.text, "abi <abi/4.0>,\ninclude <tunables/global>\nprofile bwrap /usr/bin/bwrap flags=(unconfined) {\n  userns,\n}\n");
  assert.deepEqual(ok.left, ["bwrap"]);
  // The parser refuses it: the profile this run created goes, and no temporary file stays.
  const bad = profileRun("false");
  assert.notEqual(bad.status, 0);
  assert.deepEqual(bad.left, []);
});

test("a profile that appeared before the step ran is neither overwritten nor removed", { skip: !shOk && "no sh" }, () => {
  for (const parser of ["true", "false"] as const) {
    const r = profileRun(parser, (file) => writeFileSync(file, "# someone else's\n"));
    assert.notEqual(r.status, 0);
    assert.equal(r.text, "# someone else's\n");
    assert.deepEqual(r.left, ["bwrap"]);
  }
});

test("macOS's git stub is found through symlinks: only /usr/bin/git without the developer tools counts", () => {
  assert.equal(helper.appleGitStub("/usr/bin/git", () => false), true);
  assert.equal(helper.appleGitStub("/usr/bin/git", () => true), false);
  // /usr/local/bin/git linking to the stub resolves to /usr/bin/git before this check; another git is never the stub.
  assert.equal(helper.appleGitStub("/opt/homebrew/Cellar/git/2.47.0/bin/git", () => false), false);
});
