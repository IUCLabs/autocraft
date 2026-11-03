import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { connect } from "../src/db.ts";
import { getBatch, insertBatch, restartCheck, updateBatch } from "../src/merge/batch-store.ts";
import { SCRATCH } from "./scratch.ts";

mkdirSync(SCRATCH, { recursive: true });

test("a new sandbox task clears the summary of the earlier failed one", () => {
  const db = connect(join(mkdtempSync(join(SCRATCH, "restart-")), "t.db"));
  const id = insertBatch(db, { repo: "app", branch: "integration-app-20260101-1", baseSha: "a", commitSha: "b", parentId: null, taskId: 1, members: [{ number: 1, head_oid: "h" }], at: "2026-01-01T00:00:00Z" });
  updateBatch(db, id, "2026-01-01T01:00:00Z", { summary: "sandbox: The worker stopped answering twice" });
  restartCheck(db, getBatch(db, id), "2026-01-01T02:00:00Z", 2);
  const b = getBatch(db, id);
  assert.deepEqual([b.state, b.task_id, b.retries, b.summary], ["checking", 2, 1, null]);
});
