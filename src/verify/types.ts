// Shared by the planner prompt (src/prompts, which imports no Node modules) and the Verify stage.

export const KINDS = ["ci-enough", "tests", "regression"] as const;
export type Kind = (typeof KINDS)[number];

/** Most crates one plan may name, and test filters per plan. */
export const MAX_CRATES = 5;
export const MAX_FILTERS = 10;
/** Added lines a regression test may have. */
export const MAX_TEST_LINES = 200;
/** The only file a regression patch may add, below the crate's directory. */
export const REGRESSION_FILE = "tests/autocraft_regression.rs";
export const PLAN_BODY_LIMIT = 3000;

export type Crate = { name: string; dir: string };

/** What the planner prompt is rendered from: one PR. `ref` is "repo#number". */
export type VerifyPlanInput = {
  /** Where the call may read the repository in the sandbox; not part of the quoted JSON. */
  repo_dir?: string;
  ref: string; title: string; body: string;
  /** The settled type label; regression is allowed only for bugfix. */
  label: string | null;
  /** The repo has upstream CI, which already runs the tests: the plan is `ci-enough` or `regression`, never `tests`. */
  ci: boolean;
  review: { verdict: string; reason: string; risks: string[]; fixes: { file: string; change: string }[] };
  crates: Crate[];
  files: string[]; tests_omitted: string[];
  diff: string;
};

export const SAMPLE_VERIFY_PLAN: VerifyPlanInput[] = [{
  ref: "photocraft#1287", title: "Fix crash when opening a 16-bit PNG with an alpha channel",
  body: "Opening a 16-bit RGBA PNG panicked in the decoder because the row stride was computed for 8-bit samples.\n\nFixes #1279",
  label: "bugfix", ci: true,
  review: { verdict: "take", reason: "Correct stride for 16-bit samples; small and focused.", risks: ["No test for 16-bit grayscale."], fixes: [] },
  crates: [{ name: "codecs", dir: "crates/codecs" }, { name: "photocraft-app", dir: "crates/app" }],
  files: ["crates/codecs/src/png.rs"], tests_omitted: ["crates/codecs/tests/png16.rs"],
  diff: "diff --git a/crates/codecs/src/png.rs b/crates/codecs/src/png.rs\n--- a/crates/codecs/src/png.rs\n+++ b/crates/codecs/src/png.rs\n@@ -88,7 +88,8 @@ fn decode_rows(info: &Info, data: &[u8]) -> Result<Image, DecodeError> {\n-    let stride = info.width as usize * info.channels as usize;\n+    let bytes_per_sample = if info.bit_depth == 16 { 2 } else { 1 };\n+    let stride = info.width as usize * info.channels as usize * bytes_per_sample;\n",
}];

/** Words a failure summary may have, and the part of the failing step's log the summariser sees. */
export const MAX_SUMMARY_WORDS = 60;
export const SUMMARY_LOG_BYTES = 64 * 1024;

/** What the failure-summary prompt is rendered from: one failed step. `log` is the end of its output. */
export type VerifySummaryInput = { ref: string; step: string; command: string; log: string };

export const SAMPLE_VERIFY_SUMMARY: VerifySummaryInput[] = [{
  ref: "photocraft#1287", step: "test", command: "cargo test --offline --locked -p codecs",
  log: "running 2 tests\ntest png::decode_16bit_rgba ... FAILED\ntest png::decode_8bit ... ok\n\nfailures:\n\n---- png::decode_16bit_rgba stdout ----\nthread 'png::decode_16bit_rgba' (16-bit PNG with an alpha channel) panicked at crates/codecs/src/png.rs:91:9:\nassertion `left == right` failed\n  left: 4096\n right: 8192\n\nerror: test failed, to rerun pass `-p codecs --lib`\n",
}];
