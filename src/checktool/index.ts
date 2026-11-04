// The build tool of the patch-writing models: `check` runs fmt, clippy, cargo check or cargo test on the model's current
// patch, on a worker (the only place the contributor's code is compiled), and returns trimmed output. The model's sandbox
// reaches this through a loopback bridge (bridge.ts). The harness's own lint task (src/prepush) still runs before every push.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { TaskStep } from "../../web/src/api/types.ts";
import { cancelTask, createTask, getTask, TERMINAL, warmKeyOf } from "../build/tasks.ts";
import { gitFormatDiff } from "../cifix/index.ts";
import { CHECK_MAX_CALLS, CHECK_MAX_WALL_MS, CHECK_OUTPUT_LINES } from "../core/rules.ts";
import type { Git } from "../fixup/git.ts";
import { artifactText, changedRsFiles, lintPlan, lintSteps, readLint } from "../prepush/index.ts";
import { rustPlan } from "../worker/rust.ts";

export const CHECK_COMMANDS = ["fmt", "clippy", "check", "test"] as const;
export type CheckCommand = (typeof CHECK_COMMANDS)[number];
export type CheckInput = { patch: string; command: CheckCommand; crate?: string; test_name?: string };
export type CheckResult = { text: string; isError?: boolean };

const CRATE = /^[A-Za-z0-9_-]{1,64}$/;
const TEST_NAME = /^[A-Za-z0-9_:]{1,200}$/;
const OUT = { check: "check", test: "test" } as const;

export class CheckRefused extends Error {}

/** The tool's input, or a CheckRefused that says what is wrong. Commands outside the four are refused. */
export function parseCheckInput(raw: unknown): CheckInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new CheckRefused("the input must be an object");
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!["patch", "command", "crate", "test_name"].includes(k)) throw new CheckRefused(`unknown argument "${k}"`);
  if (typeof o.command !== "string" || !(CHECK_COMMANDS as readonly string[]).includes(o.command)) throw new CheckRefused(`command must be one of ${CHECK_COMMANDS.join(", ")}`);
  if (typeof o.patch !== "string" || !o.patch.trim()) throw new CheckRefused("patch must be your complete diff");
  if (o.patch.length > 900_000 || o.patch.includes("\0")) throw new CheckRefused("patch is too large or not text");
  const command = o.command as CheckCommand;
  let crate: string | undefined, test_name: string | undefined;
  if (command === "test") {
    if (typeof o.crate !== "string" || !CRATE.test(o.crate)) throw new CheckRefused("test needs crate, a crate name");
    crate = o.crate;
    if (o.test_name !== undefined) {
      if (typeof o.test_name !== "string" || !TEST_NAME.test(o.test_name)) throw new CheckRefused("test_name must be a test name filter (letters, digits, _ and ::)");
      test_name = o.test_name;
    }
  } else if (o.crate !== undefined || o.test_name !== undefined) throw new CheckRefused("crate and test_name are only for test");
  return { patch: o.patch, command, ...(crate && { crate }), ...(test_name && { test_name }) };
}

/** Wraps a cargo command so its output and exit code come back as artifacts whatever the exit code. */
const cargoScript = (name: string, command: string): string => `${command} > /out/${name}.txt 2>&1; echo $? > /out/${name}.exit; true`;

/** The worker steps for a command on a patch, or null when the command has nothing to do (fmt and clippy on a patch with no `.rs` file). */
export function checkPlan(i: CheckInput): TaskStep[] | null {
  const [fetch] = rustPlan({ test: false });
  switch (i.command) {
    case "fmt": {
      const files = changedRsFiles(i.patch);
      return files.length ? [lintSteps(files)[0]!] : null;
    }
    case "clippy": return lintPlan(changedRsFiles(i.patch));
    case "check":
      return [fetch!, { name: "check", cmd: ["sh", "-c", cargoScript(OUT.check, "cargo check --offline --locked --workspace --all-targets --color never"), "check"], network: "none", timeoutSec: 3600, artifacts: [`${OUT.check}.txt`, `${OUT.check}.exit`] }];
    case "test": {
      const script = cargoScript(OUT.test, 'if [ -n "$2" ]; then cargo test --offline --locked --color never -p "$1" -- "$2"; else cargo test --offline --locked --color never -p "$1"; fi');
      return [fetch!, { name: "test", cmd: ["sh", "-c", script, "test", i.crate!, ...(i.test_name ? [i.test_name] : [])], network: "none", timeoutSec: 3600, artifacts: [`${OUT.test}.txt`, `${OUT.test}.exit`] }];
    }
  }
}

/** The last `n` lines of `text`, with a note when lines were dropped. */
export function lastLines(text: string, n = CHECK_OUTPUT_LINES): string {
  const lines = text.replace(/\s+$/, "").split("\n");
  return lines.length <= n ? lines.join("\n") : `[${lines.length - n} earlier lines left out]\n${lines.slice(-n).join("\n")}`;
}

/** The first `n` lines of `text`, with a note when lines were dropped. */
const firstLines = (text: string, n: number): string => {
  const lines = text.replace(/\s+$/, "").split("\n");
  return lines.length <= n ? lines.join("\n") : `${lines.slice(0, n).join("\n")}\n[${lines.length - n} more lines left out]`;
};

/** What the item is and which commit the patch applies to. */
export type CheckTarget = {
  db: DatabaseSync;
  /** The pipeline step that owns the model call: fixup, cifix or fixissue. */
  step: "fixup" | "cifix" | "fixissue";
  repo: string; number: number | null; head: string; base: string | null;
  /** Null when the patch applies to `head`, else why it does not. */
  applies: (patch: string) => Promise<string | null>;
};

/** `git apply --check` of a patch on a commit, through a temporary index. */
export function applyCheck(git: Pick<Git, "applyToTree">, root: string, head: string): CheckTarget["applies"] {
  return async (patch) => {
    mkdirSync(root, { recursive: true });
    const scratch = mkdtempSync(join(root, ".check-"));
    try {
      const r = await git.applyToTree(head, patch.endsWith("\n") ? patch : `${patch}\n`, join(scratch, "index"));
      return r.ok ? null : r.reason;
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  };
}

/**
 * One model call's build tool. Counts its calls and wall time against the limits; each run is a worker task and a row in
 * model_checks. `pollMs` is public so tests can shorten it.
 */
export class CheckTool {
  pollMs = 1000;
  calls = 0;
  usedMs = 0;
  /** Commands that came back with a result (not refused, not failed to run). */
  readonly ran = new Set<CheckCommand>();
  readonly target: CheckTarget;
  readonly limits: { calls: number; wallMs: number };
  constructor(target: CheckTarget, limits = { calls: CHECK_MAX_CALLS, wallMs: CHECK_MAX_WALL_MS }) {
    this.target = target;
    this.limits = limits;
  }

  async run(raw: unknown, runId: number | null = null): Promise<CheckResult> {
    let i: CheckInput;
    try { i = parseCheckInput(raw); } catch (e) {
      if (e instanceof CheckRefused) return { text: `refused: ${e.message}`, isError: true };
      throw e;
    }
    const t = this.target;
    if (this.calls >= this.limits.calls) return { text: `refused: ${this.limits.calls} check calls are used up; answer with your best patch`, isError: true };
    const left = this.limits.wallMs - this.usedMs;
    if (left <= 0) return { text: "refused: the time for checks is used up; answer with your best patch", isError: true };
    const bad = await t.applies(i.patch);
    if (bad) return { text: `the patch does not apply to the head commit: ${bad}`, isError: true };
    const plan = checkPlan(i);
    if (!plan) return { text: i.command === "fmt" ? "rustfmt: the patch changes no .rs file; nothing to format" : "clippy: the patch changes no .rs file; nothing to lint" };

    this.calls++;
    const started = Date.now();
    const row = Number(t.db.prepare("INSERT INTO model_checks (run_id, step, repo, number, head, command, crate, test_name, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(runId, t.step, t.repo, t.number, t.head, i.command, i.crate ?? null, i.test_name ?? null, new Date().toISOString()).lastInsertRowid);
    const end = (outcome: string, taskId: number | null) => t.db.prepare("UPDATE model_checks SET outcome = ?, task_id = ?, ended_at = ? WHERE id = ?").run(outcome.slice(0, 200), taskId, new Date().toISOString(), row);
    let taskId: number | null = null;
    try {
      taskId = createTask(t.db, {
        step: t.step, repo: t.repo, number: t.number, headSha: t.head, baseSha: t.base ?? t.head, requires: { os: "linux", toolchains: ["rust-stable"] },
        warm: { key: warmKeyOf(t.repo), role: "use" }, plan, patch: i.patch,
      });
      let state = getTask(t.db, taskId)?.state;
      while (state && !TERMINAL.includes(state)) {
        if (Date.now() - started >= left) {
          try { cancelTask(t.db, taskId, "check-tool"); } catch { /* it ended meanwhile */ }
          end("out of time", taskId);
          return { text: "the check ran out of the time allowed for checks and was stopped; answer with your best patch", isError: true };
        }
        await new Promise((r) => setTimeout(r, this.pollMs));
        state = getTask(t.db, taskId)?.state;
      }
      const r = this.read(i, taskId);
      if (!r.isError) this.ran.add(i.command);
      end(r.outcome, taskId);
      return { text: r.text, ...(r.isError && { isError: true }) };
    } catch (e) {
      const why = String((e as Error).message ?? e).slice(0, 200);
      end(`failed: ${why}`, taskId);
      return { text: `the check could not run: ${why}`, isError: true };
    } finally {
      this.usedMs += Date.now() - started;
    }
  }

  private read(i: CheckInput, taskId: number): { text: string; outcome: string; isError?: boolean } {
    const { db } = this.target;
    if (i.command === "clippy" || i.command === "fmt") {
      const r = readLint(db, taskId, { against: i.patch });
      if (r.kind !== "result" && !(i.command === "fmt" && getTask(db, taskId)?.state === "done")) {
        const reason = r.kind === "infra-failed" ? r.reason : "the task is still pending";
        return { text: `the check failed to run: ${reason}`, outcome: `failed: ${reason}`, isError: true };
      }
      const fmt = artifactText(db, taskId, "format.txt");
      const fmtDiff = fmt && fmt.trim() ? gitFormatDiff(fmt) : null;
      if (i.command === "fmt") {
        return fmtDiff
          ? { text: `rustfmt would change the patch's files as follows (apply these changes to your patch):\n${firstLines(fmtDiff, CHECK_OUTPUT_LINES)}`, outcome: "formatting differs" }
          : { text: "rustfmt: no changes; the patch's files are formatted", outcome: "formatted" };
      }
      if (r.kind !== "result") return { text: "the check failed to run", outcome: "failed", isError: true };
      const n = r.findings.length;
      const body = r.findings.map((f) => f.rendered).join("\n\n");
      const text = n ? `clippy: ${n} finding${n === 1 ? "" : "s"} on the patch's lines or compile errors:\n${firstLines(body, CHECK_OUTPUT_LINES)}` : "clippy: 0 findings on the patch's lines, no compile errors";
      return { text: fmtDiff ? `${text}\n\nrustfmt would also change the files as follows:\n${firstLines(fmtDiff, 60)}` : text, outcome: `${n} finding${n === 1 ? "" : "s"}` };
    }
    const name = i.command === "check" ? OUT.check : OUT.test;
    const t = getTask(db, taskId);
    const exit = artifactText(db, taskId, `${name}.exit`)?.trim();
    const out = artifactText(db, taskId, `${name}.txt`);
    if (t?.state !== "done" || exit === undefined || out === null) {
      const why = t?.summary ? `: ${t.summary.slice(0, 200)}` : "";
      return { text: `the check failed to run (task ${t?.state ?? "gone"}${why})`, outcome: `failed: task ${t?.state ?? "gone"}`, isError: true };
    }
    return { text: `cargo ${i.command} exit code ${exit}\n${lastLines(out)}`, outcome: `exit ${exit}` };
  }
}
