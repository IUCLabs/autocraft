// "Run on my Task Runner" picks and Manual only: a pick goes to the picker's runners first and no one else's while it counts;
// it lapses with its time or its picker's runners and does not count while its picker cannot take it; a Manual only user's
// runners take only their picks and are no room; the queue view hides picker logins and errors from viewers.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import * as modelQueue from "../src/dash/api/model-queue.ts";
import { handleMcp } from "../src/dash/mcp/index.ts";
import * as userSettings from "../src/dash/api/user-settings.ts";
import { createToken } from "../src/dash/mcp/tokens.ts";
import type { Req, Role } from "../src/dash/types.ts";
import { connect } from "../src/db.ts";
import { claimCall, dropQueueCache, enqueueCall, type Caller } from "../src/remote/calls.ts";
import { parseStatus, STATUS_FRESH_MS, storeStatus } from "../src/remote/helpers.ts";
import { RateLimiter } from "../src/dash/server/util.ts";
import { setUserMaxCalls } from "../src/remote/max-calls.ts";
import { setInferenceMode } from "../src/remote/mode.ts";
import { pickCall, setPickMinutes, unpickCall } from "../src/remote/picks.ts";
import { PROTOCOL_VERSION, type Claim, type Tier } from "../src/remote/protocol.ts";
import { whyWaiting, type ReadyRunner } from "../src/remote/queue-view.ts";
import { remoteRoom } from "../src/remote/room.ts";
import { takerTest } from "../src/remote/takers.ts";
import { addFastTrack } from "../src/fasttrack.ts";
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

  test("a pick does not count while its picker is cooling off or at their Max calls at once", async () => {
    const a = q();
    await pickCall(db, user("bob"), a);
    db.prepare("INSERT INTO remote_cooloffs (login, until, reason) VALUES ('Bob', ?, 'testing cool-off')").run(Date.now() + 60_000);
    assert.equal(await leased("alice"), a, "bob is cooling off: alice's runner takes his pick");
    db.prepare("DELETE FROM remote_cooloffs WHERE login = 'bob'").run();
    setUserMaxCalls(db, "bob", 1);
    const b = q();
    await pickCall(db, user("bob"), b);
    assert.equal(await leased("alice"), null, "bob may still take it");
    const held = q({ ageMs: 60_000 });
    db.prepare("UPDATE remote_calls SET state = 'leased', user_login = 'bob', leased_at = ?, heartbeat_at = ? WHERE id = ?").run(Date.now(), Date.now(), held);
    dropQueueCache(db);
    assert.equal(await leased("alice"), b, "bob runs his Max calls at once: alice's runner takes his pick");
    setUserMaxCalls(db, "bob", null);
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

  test("the MCP model call tools apply the queue page's rules: viewers list without pickers and cannot pick; a pick is audited via mcp", async () => {
    const a = q();
    await pickCall(db, user("bob"), a);
    const b = q();
    const env = (login: string, role: Role) => ({ db, user: () => user(login, role) as any, baseUrl: null, limiter: new RateLimiter(10, 60_000), canAnswer: false, expensive: () => 0, userLocal: true });
    const rpc = async (login: string, role: Role, method: string, params?: Record<string, unknown>) => (await handleMcp(env(login, role), { jsonrpc: "2.0", id: 1, method, ...(params && { params }) }))!.result as any;
    const names = async (login: string, role: Role) => (await rpc(login, role, "tools/list")).tools.map((t: { name: string }) => t.name).filter((n: string) => n.includes("model_call"));
    assert.deepEqual(await names("eve", "viewer"), ["list_model_calls"]);
    assert.deepEqual(await names("alice", "maintainer"), ["list_model_calls", "pick_model_call", "unpick_model_call"]);
    const listed = (await rpc("eve", "viewer", "tools/call", { name: "list_model_calls", arguments: {} })).content[0].text as string;
    assert.match(listed, /"picked": "a user"/);
    assert.doesNotMatch(listed, /bob/);
    const refused = await rpc("eve", "viewer", "tools/call", { name: "pick_model_call", arguments: { id: String(b) } });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /only maintainers and operators/);
    const taken = await rpc("alice", "maintainer", "tools/call", { name: "pick_model_call", arguments: { id: String(a) } });
    assert.equal(taken.isError, true);
    assert.match(taken.content[0].text, /another user picked it/);
    assert.equal((await rpc("alice", "maintainer", "tools/call", { name: "pick_model_call", arguments: { id: String(b) } })).isError, undefined);
    assert.equal(pickedBy(b), "alice");
    assert.ok(db.prepare("SELECT 1 FROM audit WHERE action = 'remote-pick' AND login = 'alice' AND details LIKE '%\"via\":\"mcp\"%'").get());
    await rpc("alice", "maintainer", "tools/call", { name: "unpick_model_call", arguments: { id: String(b) } });
    assert.equal(pickedBy(b), null);
    clear();
  });

  test("My tasks: unticked tasks are left in the queue for others; a pick and every task again still run", async () => {
    const all = (await userSettings.settings(db, req("alice", "maintainer"))).taskChoices.map((t) => t.id);
    assert.deepEqual((await userSettings.settings(db, req("alice", "maintainer"))).tasks, all, "every task is ticked by default");
    const put = (tasks: unknown) => userSettings.setSettings(db, req("alice", "maintainer", { json: { tasks } }));
    await assert.rejects(put(["review", "nope"]), /unknown task: nope/);
    assert.deepEqual((await put(all.filter((t) => t !== "review"))).tasks, all.filter((t) => t !== "review"));
    const step = (id: number, s: string) => db.prepare("UPDATE remote_calls SET step = ? WHERE id = ?").run(s, id);
    const review = q({ ageMs: 60_000 }), fix = q();
    step(review, "opus-review");
    step(fix, "fixissue");
    dropQueueCache(db);
    assert.equal(await leased("alice"), fix, "the older review is passed over");
    assert.equal(await leased("alice"), null);
    assert.equal(await leased("bob"), review, "another user who takes reviews gets it");
    const picked = q();
    step(picked, "opus-review");
    dropQueueCache(db);
    await pickCall(db, user("alice"), picked);
    assert.equal(await leased("alice"), picked, "a call alice picked runs although she unticked its task");
    const later = q();
    step(later, "opus-review");
    dropQueueCache(db);
    await put(all);
    assert.equal(db.prepare("SELECT 1 FROM user_settings WHERE login = 'alice' AND key = 'skip_tasks'").get(), undefined, "every task ticked again stores nothing");
    assert.equal(await leased("alice"), later);
    clear();
  });

  test("My tasks items: fast-tracked only takes calls on fast-tracked items; by me only on the user's own; a repo counts only with such an item", async () => {
    const ins = db.prepare("INSERT OR IGNORE INTO items (repo, number, kind, state, title, author, created_at) VALUES ('photocraft', ?, 'pr', 'OPEN', 'x', 'dev', '2026-01-01T00:00:00Z')");
    for (const n of [10, 11, 12]) ins.run(n);
    const put = (taskItems: unknown) => userSettings.setSettings(db, req("alice", "maintainer", { json: { taskItems } }));
    assert.equal((await userSettings.settings(db, req("alice", "maintainer"))).taskItems, "all", "every item by default");
    await assert.rejects(put("some"), /taskItems must be one of/);
    await put("fast");
    const at = (n: number) => [{ repo: "photocraft", number: n }];
    const takes = () => takerTest(db, Date.now());
    // Only alice's runner is fresh, so the taker rule reads her choice alone.
    db.prepare("UPDATE remote_helpers SET reported_at = ? WHERE login <> 'alice'").run(Date.now() - STATUS_FRESH_MS - 1000);
    assert.equal(takes()({ prompt_id: "review.opus", repos: ["photocraft"], step: "opus-review" }), false, "no fast-tracked item on the repo: no taker before the items are known");

    q({ ageMs: 60_000, items: at(10) });
    const bobs = q({ items: at(11) }), mixed = q({ items: [...at(10), ...at(12)] });
    addFastTrack(db, "bob", "photocraft#11");
    addFastTrack(db, "alice", "photocraft#12");
    dropQueueCache(db);
    assert.equal(takes()({ prompt_id: "review.opus", repos: ["photocraft"], step: "opus-review" }), true, "the repo now has fast-tracked items");
    assert.equal(takes()({ prompt_id: "review.opus", repos: ["photocraft"], step: "opus-review", refs: at(10) }), false, "but not this item");
    assert.equal(await leased("alice"), bobs, "the older call on an item nobody fast-tracked is passed over");
    assert.equal(await leased("alice"), mixed, "one fast-tracked item of a call is enough");
    assert.equal(await leased("alice"), null);
    clear();

    await put("mine");
    const theirs = q({ ageMs: 60_000, items: at(11) }), own = q({ items: at(12) });
    dropQueueCache(db);
    assert.equal(await leased("alice"), own, "only the item alice fast-tracked");
    for (const login of ["bob", "olga"]) ready(login);
    assert.equal(await leased("bob"), theirs, "a runner that takes every item gets the rest");
    assert.equal(await leased("alice"), null, "nothing else alice fast-tracked");

    const r: ReadyRunner = { login: "alice", role: "maintainer", manual: false, tiers: new Set<Tier>(["top"]), free: 1, repos: null, skip: new Set<string>(), items: { refs: new Set(["photocraft#12"]), repos: new Set(["photocraft"]) } };
    const c = { tier: "top" as Tier, promptId: "review.opus", step: "opus-review", repos: ["photocraft"], followUp: false, picked: null };
    assert.equal(whyWaiting({ ...c, refs: at(10) }, [r], 0, () => true).code, "items-off");
    assert.equal(whyWaiting({ ...c, refs: at(12) }, [r], 0, () => true).code, "behind");
    await put("all");
    assert.equal(db.prepare("SELECT 1 FROM user_settings WHERE login = 'alice' AND key = 'task_items'").get(), undefined, "every item again stores nothing");
    clear();
  });

  test("why a call waits", () => {
    const r = (o: Partial<ReadyRunner> = {}): ReadyRunner => ({ login: "bob", role: "maintainer", manual: false, tiers: new Set<Tier>(["top"]), free: 1, repos: null, skip: new Set<string>(), ...o });
    const c = { tier: "top" as Tier, promptId: "review.opus", step: "opus-review", repos: ["photocraft"], followUp: false, picked: null };
    const write = () => true;
    assert.equal(whyWaiting({ ...c, picked: { login: "bob" } }, [r()], 0, write).text, "Picked by bob");
    assert.equal(whyWaiting({ ...c, followUp: true }, [r()], 0, write).code, "session");
    assert.equal(whyWaiting({ ...c, tier: "mid" }, [r()], 0, write).code, "no-runner");
    assert.equal(whyWaiting(c, [r({ manual: true })], 0, write).code, "manual-only");
    assert.equal(whyWaiting(c, [r()], 0, () => false).code, "no-repo-access");
    assert.equal(whyWaiting({ ...c, repos: [] }, [r()], 0, write).code, "no-repo-access", "a repo-less call goes to operators only");
    assert.equal(whyWaiting(c, [r({ skip: new Set(["review"]) })], 0, write).code, "task-off");
    assert.equal(whyWaiting(c, [r({ skip: new Set(["review"]) }), r({ free: 0 })], 0, write).code, "busy", "the free runner does not take reviews");
    assert.equal(whyWaiting(c, [r({ free: 0 }), r({ manual: true })], 0, write).code, "busy");
    assert.deepEqual(whyWaiting(c, [r()], 3, write), { code: "behind", text: "3 calls ahead" });
  });
});
