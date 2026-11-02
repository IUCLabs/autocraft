// The planner's reply, validated hard: anything that does not check out is an error and creates no task.
import { KINDS, MAX_CRATES, MAX_FILTERS, MAX_TEST_LINES, REGRESSION_FILE, type Crate, type Kind } from "./types.ts";

export const FILTER_RE = /^[A-Za-z0-9_:]{1,100}$/;
const MAX_REASON_WORDS = 25;

export type VerifyPlan =
  | { kind: "ci-enough"; reason: string }
  | { kind: "tests"; reason: string; crates: string[]; tests: string[] }
  | { kind: "regression"; reason: string; crate: string; dir: string; patch: string };

export type Parsed = { ok: true; plan: VerifyPlan } | { ok: false; error: string };

const fail = (error: string): Parsed => ({ ok: false, error });
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Path of the regression test file for a crate directory ("." is the repo root). */
export const regressionPath = (dir: string): string => (dir === "." ? REGRESSION_FILE : `${dir}/${REGRESSION_FILE}`);

/** The diff that adds `content` as the crate's regression test file. */
export function patchFor(dir: string, content: string): string {
  const path = regressionPath(dir);
  const body = content.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  return `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${body.length} @@\n${body.map((l) => `+${l}`).join("\n")}\n`;
}

/**
 * Checks by parsing that `patch` adds exactly one new file, `path`, with at most MAX_TEST_LINES lines and
 * nothing else: no other file, no deletion, rename, mode change or binary content. Returns why not, or null.
 */
export function patchProblem(patch: string, path: string): string | null {
  if (!patch.endsWith("\n")) return "patch does not end with a newline";
  const lines = patch.slice(0, -1).split("\n");
  const header = [`diff --git a/${path} b/${path}`, "new file mode 100644", "--- /dev/null", `+++ b/${path}`];
  for (let i = 0; i < header.length; i++) if (lines[i] !== header[i]) return `patch line ${i + 1} is not "${header[i]}"`;
  const hunk = /^@@ -0,0 \+1,(\d+) @@$/.exec(lines[4] ?? "");
  if (!hunk) return "patch has no single new-file hunk";
  const body = lines.slice(5);
  if (body.some((l) => !l.startsWith("+"))) return "patch has lines other than additions";
  if (body.length !== Number(hunk[1])) return "hunk length does not match its lines";
  if (body.length < 1 || body.length > MAX_TEST_LINES) return `regression test must have 1 to ${MAX_TEST_LINES} lines`;
  if (body.some((l) => l.includes("\0"))) return "patch must be text";
  return null;
}

const clip = (s: string): string => s.trim().split(/\s+/).slice(0, MAX_REASON_WORDS).join(" ");

/**
 * Parses and validates the reply for the PR `ref`. `crates` is the workspace's list; `label` the settled type label.
 */
export function parsePlanReply(text: string, ref: string, crates: Crate[], label: string | null): Parsed {
  const a = text.indexOf("["), b = text.lastIndexOf("]");
  if (a < 0 || b < a) return fail("no JSON list in the reply");
  let arr: unknown;
  try { arr = JSON.parse(text.slice(a, b + 1)); } catch { return fail("reply is not valid JSON"); }
  if (!Array.isArray(arr) || arr.length !== 1 || !isObj(arr[0])) return fail("reply must be a list of one object");
  const o = arr[0];
  if (o.ref !== ref) return fail("reply is for another PR");
  if (typeof o.kind !== "string" || !(KINDS as readonly string[]).includes(o.kind)) return fail("unknown kind");
  if (typeof o.reason !== "string" || !o.reason.trim()) return fail("reason is missing");
  const reason = clip(o.reason);
  const kind = o.kind as Kind;
  if (kind === "ci-enough") return { ok: true, plan: { kind, reason } };
  const names = new Set(crates.map((c) => c.name));
  if (kind === "tests") {
    const cs = o.crates, ts = o.tests ?? [];
    if (!Array.isArray(cs) || cs.length < 1 || cs.length > MAX_CRATES) return fail(`crates must list 1 to ${MAX_CRATES} names`);
    if (cs.some((c) => typeof c !== "string" || !names.has(c))) return fail("crates names a crate that is not in the workspace");
    if (!Array.isArray(ts) || ts.length > MAX_FILTERS || ts.some((t) => typeof t !== "string" || !FILTER_RE.test(t))) return fail("a test filter is not valid");
    return { ok: true, plan: { kind, reason, crates: [...new Set(cs as string[])], tests: ts as string[] } };
  }
  if (label !== "bugfix") return fail("regression is only for bugfix PRs");
  const c = crates.find((x) => x.name === o.crate);
  if (!c || typeof o.crate !== "string") return fail("crate is not in the workspace");
  if (!/^[A-Za-z0-9_./-]+$/.test(c.dir) || c.dir.split("/").includes("..")) return fail("crate directory is not a plain path");
  if (typeof o.test_file !== "string" || !o.test_file.trim()) return fail("test_file is missing");
  const patch = patchFor(c.dir, o.test_file);
  const problem = patchProblem(patch, regressionPath(c.dir));
  if (problem) return fail(problem);
  return { ok: true, plan: { kind, reason, crate: c.name, dir: c.dir, patch } };
}
