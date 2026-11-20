// "Run on my Task Runner" picks and Manual only: a pick goes to the picker's runners first and no one else's while it counts;
// it lapses with its time or its picker's runners; a Manual only user's runners take only their picks and are no room; the
// queue view hides picker logins and errors from viewers.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import * as modelQueue from "../src/dash/api/model-queue.ts";
import * as userSettings from "../src/dash/api/user-settings.ts";
import { createToken } from "../src/dash/mcp/tokens.ts";
import type { Req, Role } from "../src/dash/types.ts";
import { connect } from "../src/db.ts";
import { claimCall, dropQueueCache, enqueueCall, type Caller } from "../src/remote/calls.ts";
import { parseStatus, STATUS_FRESH_MS, storeStatus } from "../src/remote/helpers.ts";
import { setInferenceMode } from "../src/remote/mode.ts";
import { pickCall, setPickMinutes, unpickCall } from "../src/remote/picks.ts";
import { PROTOCOL_VERSION, type Claim, type Tier } from "../src/remote/protocol.ts";
import { whyWaiting, type ReadyRunner } from "../src/remote/queue-view.ts";
import { remoteRoom } from "../src/remote/room.ts";
import { SCRATCH } from "./scratch.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "remote-picks-"));

describe("picks and Manual only", () => {
  const db = connect(join(dir, "t.db"));
  setInferenceMode(db, "user-local", "test");
  db.prepare("INSERT OR IGNORE INTO tracked_repos (name) VALUES ('photocraft')").run();
  db.prepare("INSERT INTO repos (name, visibility) VALUES ('photocraft', 'public') ON CONFLICT (name) DO UPDATE SET visibility = 'public'").run();
  const callers: Record<string, Caller> = {};
  for (const [login, role] of [["alice", "maintainer"], ["bob", "maintainer"], ["olga", "operator"], ["eve", "viewer"]] as const) {
    db.prepare("INSERT INTO access (login, role) VALUES (?, ?)").run(login, role);
    if (role !== "viewer") callers[login] = { tokenId: createToken(db, login, "runner", { kind: "runner" }).row.id, login, role };
  }
  /** The user's runner reports ready now: two slots and the fast lane. */
  const ready = (login: string) => storeStatus(db, callers[login]!.tokenId, login, parseStatus({ slots: 3, busy: 0, readiness: "ready", harness: "claude", models: { top: "opus", small: "haiku" }, reserve: { fiveHour: 0, weekly: 0 } }));
  for (const login of ["alice", "bob", "olga"]) ready(login);
  let claims = 0;
  const claim = (extra: Partial<Claim> = {}): Claim => ({ requestId: `picks-claim-${String(++claims).padStart(4, "0")}`, protocol: PROTOCOL_VERSION, helperVersion: "1.2.0", harness: "claude", harnessVersion: "2.1", tiers: { top: "opus", small: "haiku" }, ...extra });
  const yes = async () => true;
  const leased = async (login: string, extra: Partial<Claim> = {}, canWrite = yes) => (await claimCall(db, callers[login]!, claim(extra), canWrite)).lease?.id ?? null;
  const user = (login: string, role: Role = "maintainer") => ({ login, role, canWrite: yes, canRead: yes });
  const req = (login: string, role: Role, extra: Partial<Req> = {}) => ({ user: user(login, role), params: {}, ...extra }) as unknown as Req;
  const q = (opts: { tier?: Tier; ageMs?: number; items?: { repo: string; number: number }[]; promptId?: string } = {}) => {
    const tier = opts.tier ?? "top", promptId = opts.promptId ?? "review.opus";
    const id = enqueueCall(db, { promptId, promptVersion: "1", tier, effort: "medium", askedModel: tier === "top" ? "opus" : "haiku", items: opts.items ?? [{ repo: "photocraft", number: 2 }], level: 0, maxAttempts: 2,
      bundle: { promptId, promptVersion: "1", tier, effort: "medium", timeoutSeconds: 60, maxTurns: null, stdin: "x", system: null, mounts: [], mcpServers: [], keepSession: true, hints: {} } });
    if (opts.ageMs) db.prepare("UPDATE remote_calls SET since = since - ? WHERE id = ?").run(opts.ageMs, id);
    return id;
  };
  const clear = () => db.prepare("UPDATE remote_calls SET state = 'failed' WHERE state IN ('queued', 'leased')").run();
  const pickedBy = (id: number) => (db.prepare("SELECT picked_by FROM remote_calls WHERE id = ?").get(id) as { picked_by: string | null }).picked_by;

  test("the picker's runners take a pick first; others pass it over; the fast lane takes only picks that fit it", async () => {
    const older = q({ ageMs: 10 * 60_000 });
    const newer = q();
    await pickCall(db, user("bob"), newer);
    assert.equal(await leased("bob"), newer, "bob's pick before the older call");
    assert.equal(pickedBy(newer), null, "the lease ends the pick");
    const third = q();
    await pickCall(db, user("bob"), third);
    assert.equal(await leased("alice"), older, "alice takes the unpicked call");
    assert.equal(await leased("alice"), null, "and not bob's pick");
    assert.equal(await leased("bob", { fastLane: true }), null, "a top-tier review does not fit the fast lane");
    assert.equal(await leased("bob"), third);
    assert.ok(db.prepare("SELECT 1 FROM audit WHERE action = 'remote-pick' AND login = 'bob' AND target = 'photocraft#2'").get());
    clear();
  });

  test("a pick lapses with its time or its picker's runners; with no time limit it lasts", async () => {
    setPickMinutes(db, 0, "test");
    const a = q();
    await pickCall(db, user("bob"), a);
    assert.equal((db.prepare("SELECT pick_until FROM remote_calls WHERE id = ?").get(a) as { pick_until: number | null }).pick_until, null);
    assert.equal(await leased("alice"), null, "no time limit: still bob's");
    db.prepare("UPDATE remote_helpers SET reported_at = ? WHERE login = 'bob'").run(Date.now() - STATUS_FRESH_MS - 1000);
    assert.equal(await leased("alice"), a, "none of bob's runners is fresh: the pick no longer counts");
    ready("bob");
    setPickMinutes(db, 15, "test");
    const b = q();
    await pickCall(db, user("bob"), b);
    assert.equal(await leased("alice"), null);
    db.prepare("UPDATE remote_calls SET pick_until = ? WHERE id = ?").run(Date.now() - 1, b);
    dropQueueCache(db);
    assert.equal(await leased("alice"), b, "the pick's time is up");
    clear();
  });

  test("a pick the picker may no longer take or released ends at their claim; two users picking at once: one wins", async () => {
    const a = q();
    await pickCall(db, user("bob"), a);
    assert.equal(await leased("bob", {}, async () => false), null, "bob lost write permission");
    assert.equal(pickedBy(a), null, "and with it the pick");
    await pickCall(db, user("bob"), a);
    db.prepare("UPDATE remote_calls SET released_by = 'bob', released_at = ? WHERE id = ?").run(Date.now(), a);
    dropQueueCache(db);
    assert.equal(await leased("bob"), null);
    assert.equal(pickedBy(a), null, "a call bob's runner released loses bob's pick");
    const results = await Promise.allSettled([pickCall(db, user("bob"), a), pickCall(db, user("alice"), a)]);
    assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
    const winner = pickedBy(a)!;
    const loser = winner === "bob" ? "alice" : "bob";
    assert.throws(() => unpickCall(db, user(loser), a), /only operators/);
    unpickCall(db, user("olga", "operator"), a);
    assert.equal(pickedBy(a), null);
    assert.ok(db.prepare("SELECT 1 FROM audit WHERE action = 'remote-unpick' AND login = 'olga' AND details LIKE ?").get(`%"picker":"${winner}"%`));
    clear();
  });

  test("a Manual only user's runners take only their picks and are no room", async () => {
    const a = q();
    // Both runners asked for work a moment ago (active), so both are room.
    for (const login of ["alice", "bob", "olga"]) db.prepare("UPDATE mcp_tokens SET idle_claim_at = ? WHERE login = ?").run(Date.now(), login);
    const room = remoteRoom(db, 0);
    await userSettings.setSettings(db, req("alice", "maintainer", { json: { manualOnly: true } }));
    assert.equal((await userSettings.settings(db, req("alice", "maintainer"))).manualOnly, true);
    assert.equal(remoteRoom(db, 0), room - 2, "alice's two slots are no room");
    assert.equal(await leased("alice"), null, "an unpicked call");
    await pickCall(db, user("alice"), a);
    assert.equal(await leased("alice"), a, "her own pick");
    await userSettings.setSettings(db, req("alice", "maintainer", { json: { manualOnly: false } }));
    assert.ok(db.prepare("SELECT 1 FROM audit WHERE action = 'manual-only' AND login = 'alice'").get());
    clear();
  });

  test("the queue view: viewers see no picker, error or repo-less call; maintainers see them and what they may pick", async () => {
    const a = q();
    const b = q();
    const loose = q({ items: [] });
    await pickCall(db, user("bob"), a);
    db.prepare("UPDATE remote_calls SET error = 'lease expired' WHERE id = ?").run(b);
    const viewer = await modelQueue.get(db, req("eve", "viewer"));
    assert.deepEqual(viewer.calls.map((c) => c.id), [a, b]);
    assert.deepEqual(viewer.calls[0]!.picked, {});
    assert.equal(viewer.calls[0]!.why.text, "Picked by a user");
    assert.equal(viewer.calls[1]!.lastError, undefined);
    assert.equal(viewer.runners.manualLogins, undefined);
    assert.deepEqual(viewer.me, { canPick: false, manualOnly: false, picks: 0, pickMax: 0 });
    const alice = await modelQueue.get(db, req("alice", "maintainer"));
    assert.deepEqual(alice.calls.map((c) => [c.id, c.picked, c.pickable]), [[a, { login: "bob" }, false], [b, null, true], [loose, null, false]]);
    assert.equal(alice.calls[1]!.lastError, "lease expired");
    assert.deepEqual(alice.me, { canPick: true, manualOnly: false, picks: 0, pickMax: 2 });
    const bob = await modelQueue.unpick(db, req("bob", "maintainer", { params: { id: String(a) } }));
    assert.equal(bob.calls[0]!.picked, null);
    clear();
  });

  test("why a call waits", () => {
    const r = (o: Partial<ReadyRunner> = {}): ReadyRunner => ({ login: "bob", role: "maintainer", manual: false, tiers: new Set<Tier>(["top"]), free: 1, repos: null, ...o });
    const c = { tier: "top" as Tier, promptId: "review.opus", repos: ["photocraft"], followUp: false, picked: null };
    const write = () => true;
    assert.equal(whyWaiting({ ...c, picked: { login: "bob" } }, [r()], 0, write).text, "Picked by bob");
    assert.equal(whyWaiting({ ...c, followUp: true }, [r()], 0, write).code, "session");
    assert.equal(whyWaiting({ ...c, tier: "mid" }, [r()], 0, write).code, "no-runner");
    assert.equal(whyWaiting(c, [r({ manual: true })], 0, write).code, "manual-only");
    assert.equal(whyWaiting(c, [r()], 0, () => false).code, "no-repo-access");
    assert.equal(whyWaiting({ ...c, repos: [] }, [r()], 0, write).code, "no-repo-access", "a repo-less call goes to operators only");
    assert.equal(whyWaiting(c, [r({ free: 0 }), r({ manual: true })], 0, write).code, "busy");
    assert.deepEqual(whyWaiting(c, [r()], 3, write), { code: "behind", text: "3 calls ahead" });
  });
});
