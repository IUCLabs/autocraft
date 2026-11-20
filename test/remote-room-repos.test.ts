// The user-local room counts only the Task Runners that may take a call on the caller's repos: one user's slots do not start
// jobs on repos only another user serves, and a queued call nobody may take holds no room from other repos.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { queueRoom, queueRoomPass, setCallContext } from "../src/agents/call.ts";
import { createToken } from "../src/dash/mcp/tokens.ts";
import { connect } from "../src/db.ts";
import { enqueueCall } from "../src/remote/calls.ts";
import { parseStatus, storeStatus } from "../src/remote/helpers.ts";
import { setInferenceMode } from "../src/remote/mode.ts";
import { setUserRepos } from "../src/remote/my-repos.ts";
import { setUserTasks, TASK_CHOICES } from "../src/remote/my-tasks.ts";
import { remoteRoom } from "../src/remote/room.ts";
import { SCRATCH } from "./scratch.ts";

mkdirSync(SCRATCH, { recursive: true });

test("room is counted per repo: runners with disjoint repos, a call nobody may take", () => {
  const db = connect(join(mkdtempSync(join(SCRATCH, "remote-room-repos-")), "t.db"));
  setInferenceMode(db, "user-local", "test");
  const at = new Date().toISOString();
  const runner = (login: string, role: string) => {
    db.prepare("INSERT INTO access (login, role) VALUES (?, ?)").run(login, role);
    const id = createToken(db, login, "helper", { kind: "runner" }).row.id;
    storeStatus(db, id, login, parseStatus({ slots: 1, busy: 0, readiness: "ready", harness: "claude", models: { top: "opus" }, reserve: { fiveHour: 0, weekly: 0 } }));
    db.prepare("UPDATE mcp_tokens SET idle_claim_at = ? WHERE id = ?").run(Date.now(), id);
    return id;
  };
  const perm = (login: string, repo: string, permission: string) =>
    db.prepare("INSERT OR REPLACE INTO repo_permissions (login, repo, permission, checked_at) VALUES (?, ?, ?, ?)").run(login, repo, permission, at);
  const room = (repos?: string[]) => remoteRoom(db, 0, Date.now(), repos);

  // The operator takes deckcraft and designcraft only; no permission of theirs on designcraft is cached yet.
  runner("olga", "operator");
  setUserRepos(db, "olga", ["deckcraft", "designcraft"]);
  perm("olga", "deckcraft", "write");
  assert.equal(room(["deckcraft"]), 1);
  assert.equal(room(["designcraft"]), 1, "no cached permission yet: the runner counts");
  assert.equal(room(["photocraft"]), 0, "not in the operator's My repos");
  assert.equal(room([]), 1, "a call that names no repo: the operator's runner");

  const photo = enqueueCall(db, { promptId: "review.opus", promptVersion: "1", tier: "top", effort: "medium", askedModel: "opus", items: [{ repo: "photocraft", number: 7 }], level: 0, maxAttempts: 1,
    bundle: { promptId: "review.opus", promptVersion: "1", tier: "top", effort: "medium", timeoutSeconds: 60, maxTurns: null, stdin: "x", system: null, mounts: [], mcpServers: [], keepSession: false, hints: {} } });
  assert.equal(room(["deckcraft"]), 1, "a queued photocraft call nobody may take holds no deckcraft room");
  assert.equal(room(), 0, "counted without repos, it does");

  // The maintainer may write to photocraft only.
  const dave = runner("dave", "maintainer");
  perm("dave", "photocraft", "write");
  perm("dave", "deckcraft", "read");
  perm("dave", "designcraft", "read");
  assert.equal(room(["deckcraft"]), 1, "dave's slot is no deckcraft room");
  assert.equal(room(["photocraft"]), 0, "dave's slot goes to the queued photocraft call first");
  assert.equal(room([]), 1, "a maintainer's runner takes no call without a repo");
  db.prepare("UPDATE remote_calls SET state = 'failed' WHERE id = ?").run(photo);
  assert.equal(room(["photocraft"]), 1);
  db.prepare("UPDATE repo_permissions SET checked_at = ? WHERE login = 'dave' AND repo = 'deckcraft'").run(new Date(Date.now() - 3600_000).toISOString());
  assert.equal(room(["deckcraft"]), 2, "a read permission confirmed an hour ago no longer leaves dave out");
  perm("dave", "deckcraft", "read");
  assert.equal(room(["photocraft", "deckcraft"]), 0, "nobody takes a call on both");

  // A job's repo param is added to the repos a pool names.
  db.prepare("UPDATE mcp_tokens SET idle_claim_at = NULL WHERE id = ?").run(dave);
  setUserRepos(db, "olga", ["designcraft"]);
  assert.equal(queueRoom(db, 0, ["designcraft"]), 1);
  const job = (repo: string) => setCallContext({ jobId: 1, step: "opus-review", stage: 5, repo, cancelled: () => false });
  try {
    job("designcraft");
    assert.equal(queueRoom(db, 0), 1);
    job("deckcraft");
    assert.equal(queueRoom(db, 0), 0, "olga no longer takes deckcraft, and dave's runner is not active");
    assert.equal(queueRoom(db, 0, ["designcraft"]), 0, "a call of a deckcraft job names deckcraft too");
  } finally {
    setCallContext(null);
  }
});

test("room and takers count only the runners whose users take the call's task (My tasks)", () => {
  const db = connect(join(mkdtempSync(join(SCRATCH, "remote-room-tasks-")), "t.db"));
  setInferenceMode(db, "user-local", "test");
  db.prepare("INSERT INTO access (login, role) VALUES ('olga', 'operator')").run();
  const id = createToken(db, "olga", "helper", { kind: "runner" }).row.id;
  storeStatus(db, id, "olga", parseStatus({ slots: 1, busy: 0, readiness: "ready", harness: "claude", models: { top: "opus" }, reserve: { fiveHour: 0, weekly: 0 } }));
  db.prepare("UPDATE mcp_tokens SET idle_claim_at = ? WHERE id = ?").run(Date.now(), id);
  setUserTasks(db, "olga", TASK_CHOICES.map((t) => t.id).filter((t) => t !== "review"));
  const room = (repos: string[] | undefined, step: string) => remoteRoom(db, 0, Date.now(), repos, step);
  assert.ok(room(["deckcraft"], "fixissue") > 0);
  assert.equal(room(["deckcraft"], "opus-review"), 0, "the only runner's user unticked Review");
  assert.equal(room(undefined, "opus-review"), 0, "with no repo named as well");
  const pass = queueRoomPass(db);
  assert.equal(pass.taker(["deckcraft"], "opus-review"), false, "no taker for the unticked task");
  assert.equal(pass.taker(["deckcraft"], "fixissue"), true);
  setCallContext({ jobId: 1, step: "opus-review", stage: 5, repo: "deckcraft", cancelled: () => false });
  try {
    assert.equal(queueRoom(db, 0, ["deckcraft"]), 0, "a review job's calls get no room");
  } finally {
    setCallContext(null);
  }
  assert.ok(remoteRoom(db, 0, Date.now()) > 0);
  setUserTasks(db, "olga", []);
  assert.equal(remoteRoom(db, 0, Date.now()), 0, "with no task ticked the user takes only picks: no room for any call");
});
