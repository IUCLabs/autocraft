import test from "node:test";
import assert from "node:assert/strict";
import { patchProblem } from "../src/worker/patch.ts";

const head = "diff --git a/x b/x\n";

test("a patch is refused unless every mode is a regular file mode", () => {
  assert.equal(patchProblem(`${head}new file mode 100644\nindex 0000000..e69de29\n--- /dev/null\n+++ b/x\n`), null);
  assert.equal(patchProblem(`${head}index e69de29..0123456 100755\n--- a/x\n+++ b/x\n`), null);
  assert.ok(patchProblem(`${head}new file mode 0120000\n--- /dev/null\n+++ b/x\n`));
  assert.ok(patchProblem(`${head}new file mode 120000\n`));
  assert.ok(patchProblem(`${head}index e69de29..0123456 160000\n`));
  assert.ok(patchProblem(`${head}new mode 100666\n`));
});
