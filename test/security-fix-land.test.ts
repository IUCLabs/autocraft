// The private fix, the quiet landing, the advisory route and publishing, with a fake gh and git: the states a finding moves
// through, and that nothing a landing writes names the problem.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { before, describe, test } from "node:test";
import { connect } from "../src/db.ts";
import type { Exec } from "../src/fixup/git.ts";
import { GITHUB_ACTIONS } from "../src/github/actions.ts";
import { fixOnMain, pollLanding, runAdvisory, runLand, runPublish, type LandDeps } from "../src/security/land.ts";
import { runFix, type FixDeps } from "../src/security/fix.ts";
import { giveaway, parseFixReply, patchGiveaway, quietProblem } from "../src/security/rules.ts";
import { rawFinding } from "../src/security/store.ts";
import { Git } from "../src/fixup/git.ts";
import { SCRATCH } from "./scratch.ts";

mkdirSync(SCRATCH, { recursive: true });
const db = connect(join(mkdtempSync(join(SCRATCH, "sec-fix-")), "dash.db"));
const BY = { operator: "boss" };
const SHA = "b".repeat(40);

type Call = { cmd: string; args: string[]; input?: string };
/** A fake gh and git: `gh` answers by the endpoint; every call is kept for the wording check. */
function fake(answers: { fork?: { code: number; stderr: string }; pr?: string } = {}): { exec: Exec; calls: Call[] } {
  const calls: Call[] = [];
  const exec: Exec = async (cmd, args, opts) => {
    calls.push({ cmd, args, input: opts?.input });
    const a = args.join(" ");
    if (cmd === "git") return { code: 0, stdout: a.includes("rev-parse") ? `${SHA}\n` : "", stderr: "" };
    if (a.includes("--jq .parent.full_name")) return { code: 0, stdout: "storytold/photocraft\n", stderr: "" };
    if (a.startsWith("pr list")) return { code: 0, stdout: "", stderr: "" };
    if (a.startsWith("pr create")) return { code: 0, stdout: `${answers.pr ?? "https://github.com/storytold/photocraft/pull/77"}\n`, stderr: "" };
    if (a.includes("security-advisories/GHSA") && a.includes("/forks")) return { code: answers.fork?.code ?? 0, stdout: answers.fork?.code ? "" : "storytold/photocraft-ghsa-aaaa\n", stderr: answers.fork?.stderr ?? "" };
    if (a.includes("security-advisories") && a.includes("POST") && !a.includes("GHSA")) return { code: 0, stdout: "GHSA-aaaa-bbbb-cccc\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  return { exec, calls };
}
const deps = (exec: Exec): LandDeps => ({ exec, root: SCRATCH, who: async () => ({ login: "pipeline-bot" }), log: () => {} });

let seq = 0;
/** A finding in `state` with a fix, as the fix step leaves it. */
function finding(state: string, extra: Record<string, string | number | null> = {}): number {
  const n = ++seq;
  const at = "2026-11-05T00:00:00Z";
  db.prepare(`INSERT INTO security_findings (repo, number, scan_id, area, title, severity, urgent, state, refs, reach, impact, fingerprint, fix_commit, fix_title, fix_summary, fix_branch, fix_files, created_at, updated_at)
    VALUES ('photocraft', ?, 1, 'psd', 'Layer length trusted', 'high', 0, ?, '[{"path":"crates/psd/src/layer.rs","line":118,"claim":""}]', 'open file', 'writes outside', ?, ?, 'Check layer length before copying', 'The reader compares the length with the remaining data and returns an error.', ?, ?, ?, ?)`)
    .run(n, state, `fp${n}`, SHA, `fix-check-layer-length-${n}`, JSON.stringify(["crates/psd/src/layer.rs", "crates/psd/tests/autocraft_regression.rs"]), at, at);
  for (const [k, v] of Object.entries(extra)) db.prepare(`UPDATE security_findings SET ${k} = ? WHERE repo = 'photocraft' AND number = ?`).run(v, n);
  return n;
}
const stateOf = (n: number) => rawFinding(db, "photocraft", n)!;

before(() => {
  db.prepare("INSERT INTO security_scans (id, repo, state, started_by, started_at, commit_sha) VALUES (1, 'photocraft', 'done', 'boss', '2026-11-05T00:00:00Z', ?)").run(SHA);
});

describe("private fix and landing", () => {
  test("the fix reply must follow the form, and wording that names the problem is found", () => {
    const ok = parseFixReply("TITLE: Check layer length\nSUMMARY: Compare with the remaining data.\n---PATCH---\ndiff --git a/x.rs b/x.rs\n--- a/x.rs\n+++ b/x.rs\n");
    assert.equal(ok?.title, "Check layer length");
    assert.equal(parseFixReply("diff --git a/x b/x"), null);
    assert.match(quietProblem("Fix buffer overflow in PSD reader", "x") ?? "", /overflow/);
    assert.equal(quietProblem("Check layer length", "Compare the length with the remaining data."), null);
    assert.equal(patchGiveaway("diff --git a/x.rs b/x.rs\n+    // block the attacker\n"), "attacker");
    assert.equal(patchGiveaway("diff --git a/x.rs b/x.rs\n+    return Err(Error::Overflow);\n-    // security\n"), null, "only added lines count, and ordinary identifiers do not");
    assert.equal(giveaway("Validate chunk sizes"), null);
  });

  test("a fix that cannot start returns the finding to new with a note", async () => {
    const n = finding("fixing");
    db.prepare("UPDATE security_scans SET commit_sha = NULL WHERE id = 1").run();
    await runFix(db, "photocraft", n, { log: () => {} } as unknown as FixDeps);
    db.prepare("UPDATE security_scans SET commit_sha = ? WHERE id = 1").run(SHA);
    assert.equal(stateOf(n).state, "new");
    assert.match(stateOf(n).note ?? "", /no pinned commit/);
  });

  test("quiet landing: a plain pull request, then landed when it merges, then published", async () => {
    const f = fake();
    const n = finding("landing");
    await runLand(db, "photocraft", n, BY, deps(f.exec));
    assert.equal(stateOf(n).state, "landing");
    assert.equal(stateOf(n).fix_pr, 77);
    // Everything sent to GitHub for the landing: arguments and bodies.
    const sent = f.calls.map((c) => `${c.args.join(" ")} ${c.input ?? ""}`).join("\n");
    assert.equal(giveaway(sent), null, `a landing write names the problem: ${giveaway(sent)}`);
    assert.match(sent, /refs\/heads\/fix-check-layer-length/);
    const pr = f.calls.find((c) => c.args[0] === "pr" && c.args[1] === "create")!;
    assert.ok(pr.args.includes("Check layer length before copying"));

    assert.equal(await pollLanding(db, deps(f.exec)), 0, "the pull request is still open");
    db.prepare("INSERT INTO items (repo, number, kind, state) VALUES ('photocraft', 77, 'pr', 'MERGED')").run();
    assert.equal(await pollLanding(db, deps(f.exec)), 1);
    assert.equal(stateOf(n).state, "landed");

    await runPublish(db, "photocraft", n, BY, true, deps(f.exec));
    assert.equal(stateOf(n).state, "published");
    assert.equal(stateOf(n).ghsa_id, "GHSA-aaaa-bbbb-cccc", "a draft advisory is made first for a quiet landing");
    const wrote = f.calls.filter((c) => c.args.join(" ").includes("security-advisories")).map((c) => c.args.join(" "));
    assert.ok(wrote.some((w) => w.includes("PATCH")) && wrote.some((w) => w.endsWith("/cve")));
  });

  test("a landing that names the problem is refused by the write layer", async () => {
    const f = fake();
    const n = finding("landing", { fix_title: "Fix path traversal in the importer" });
    await assert.rejects(runLand(db, "photocraft", n, BY, deps(f.exec)), /may not mention/);
    assert.equal(stateOf(n).state, "ready");
    assert.equal(f.calls.some((c) => c.args[0] === "pr" && c.args[1] === "create"), false);
  });

  test("a pull request closed without merging returns the fix to ready", async () => {
    const n = finding("landing", { fix_pr: 78 });
    db.prepare("INSERT INTO items (repo, number, kind, state) VALUES ('photocraft', 78, 'pr', 'CLOSED')").run();
    await pollLanding(db, deps(fake().exec));
    assert.equal(stateOf(n).state, "ready");
    assert.equal(stateOf(n).fix_pr, null);
  });

  test("advisory route: the fork steps, an admin wait on a refusal, and the merge seen on main", async () => {
    const refused = fake({ fork: { code: 1, stderr: "gh: Not Found (HTTP 404)" } });
    const n = finding("landing", { urgent: 1 });
    await runAdvisory(db, "photocraft", n, BY, deps(refused.exec));
    assert.equal(stateOf(n).state, "awaiting-admin");
    assert.equal(stateOf(n).ghsa_id, "GHSA-aaaa-bbbb-cccc");
    assert.match(stateOf(n).note ?? "", /admin must/);
    assert.equal(refused.calls.some((c) => c.args.includes("push")), false, "nothing is pushed before the fork exists");

    // Pressing Advisory again resumes after the steps that are done.
    db.prepare("UPDATE security_findings SET state = 'landing' WHERE number = ?").run(n);
    const ok = fake({ pr: "https://github.com/storytold/photocraft-ghsa-aaaa/pull/3" });
    await runAdvisory(db, "photocraft", n, BY, deps(ok.exec));
    const row = stateOf(n);
    assert.equal(row.state, "awaiting-admin");
    assert.equal(row.fork, "storytold/photocraft-ghsa-aaaa");
    assert.equal(row.fix_pr, 3);
    assert.ok(ok.calls.some((c) => c.cmd === "git" && c.args.some((a) => a.includes("storytold/photocraft-ghsa-aaaa.git"))), "the fix is pushed to the private fork");
    assert.ok(!ok.calls.some((c) => c.args.includes("security-advisories") && c.args.includes("POST") && c.args.length < 8 && !c.args.join(" ").includes("GHSA")), "the advisory is not created twice");

    // The merge shows as the fix commit being part of the default branch (the fake git answers yes to the ancestor check).
    assert.equal(await fixOnMain(new Git(ok.exec, SCRATCH, "photocraft"), SHA, SHA), true);
    assert.equal(await pollLanding(db, deps(ok.exec)), 1);
    assert.equal(stateOf(n).state, "advisory");
  });

  test("security audit actions are not GitHub feed rows", () => {
    const actions = (db.prepare("SELECT DISTINCT action FROM audit WHERE action LIKE 'security-%'").all() as { action: string }[]).map((a) => a.action);
    assert.ok(actions.length > 0);
    for (const a of actions) assert.equal(a in GITHUB_ACTIONS, false, a);
  });
});
