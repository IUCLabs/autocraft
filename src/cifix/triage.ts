// Sorts a CI failure by what would fix it, from the log text alone. No model: anything unclear is "code", where
// the patch check (Opus) stands between the model's patch and the branch.
import type { CiFailure } from "./types.ts";

export type Triage =
  | { kind: "format"; why: string }
  | { kind: "infra"; why: string }
  | { kind: "code"; why: string }
  /** Nothing readable: no failed step log to act on. */
  | { kind: "unreadable"; why: string };

/** The run itself broke, whatever the PR contains. */
const INFRA_CONCLUSION = new Set(["cancelled", "timed_out", "startup_failure", "stale"]);
const INFRA_LOG = /could not resolve host|temporary failure in name resolution|connection (reset|timed out|refused)|network is unreachable|tls handshake|failed to download|unable to access 'https|spurious network error|\b50[234] (bad gateway|service unavailable|gateway time-?out)|rate limit exceeded|runner has received a shutdown signal|lost communication with the server|no space left on device|ETIMEDOUT|ECONNRESET|failed to fetch|error: failed to get `|couldn't connect to server/i;
/** A compiler, clippy or test failure in the PR's code (case sensitive: `Error: Process completed` is the runner's line). */
const CODE_MARK = /^\s*error(\[E\d+\])?: |test result: FAILED|panicked at|^failures:$|could not compile|assertion `|-D warnings/m;
const FORMAT_STEP = /\b(fmt|format(ting)?)\b/i;
const FORMAT_DIFF = /^Diff in \S+:\d+/m;

export function triage(f: CiFailure): Triage {
  const steps = f.checks.flatMap((c) => c.steps);
  if (f.checks.length && f.checks.every((c) => INFRA_CONCLUSION.has(c.conclusion))) return { kind: "infra", why: `the run was ${f.checks[0]!.conclusion.replace("_", " ")}` };
  if (!steps.length) return { kind: "unreadable", why: "no failure log" };
  const text = steps.map((s) => s.tail).join("\n");
  const formatStep = (s: { step: string; tail: string }) => FORMAT_STEP.test(s.step) || FORMAT_DIFF.test(s.tail);
  // The formatter's own output does not carry compiler markers, so any marker means something besides formatting failed.
  if (steps.every(formatStep) && !CODE_MARK.test(text)) return { kind: "format", why: "only the formatter check failed" };
  if (INFRA_LOG.test(text) && !CODE_MARK.test(text)) return { kind: "infra", why: "the log shows a network or runner error and no error in the code" };
  return { kind: "code", why: "a build, lint or test step failed" };
}
