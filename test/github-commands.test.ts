// Commands in GitHub comments: `@<app> merge queue` from an operator queues the item as Queue items does and the app answers.
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { safeEqual } from "../src/dash/server/crypto.ts";
import { drainCommands, parseCommand, type CommandDeps } from "../src/github/commands.ts";
import { handleDelivery, signatureOf } from "../src/github/webhooks.ts";
import type { Exec } from "../src/fixup/git.ts";
import { fastTrackList } from "../src/fasttrack.ts";
import { preapprovalOf } from "../src/preapproval/index.ts";
import { OPERATOR, world, type World } from "./world-db.ts";

const SLUG = "autocraft-bot";
const SECRET = "hook-secret";
const OP_ID = 101;

let current: World | null = null;
const fresh = (off: Parameters<World["repo"]>[0] = []): World => {
  const w = (current = world().repo(off));
  w.db.prepare("UPDATE access SET github_id = ? WHERE login = ?").run(OP_ID, OPERATOR);
  return w;
};
afterEach(() => current?.close());

const payload = (o: { body: string; number?: number; login?: string; id?: number; comment?: number; action?: string; type?: string; pr?: boolean; repo?: string }) => ({
  action: o.action ?? "created",
  repository: { full_name: o.repo ?? "storytold/app", name: "app" },
  issue: { number: o.number ?? 1, ...(o.pr === false ? {} : { pull_request: { url: "x" } }) },
  comment: { id: o.comment ?? 5000, body: o.body, user: { login: o.login ?? OPERATOR, id: o.id ?? OP_ID, type: o.type ?? "User" } },
});
const deliver = (w: World, p: unknown, slug: string | null = SLUG) => {
  const raw = Buffer.from(JSON.stringify(p));
  return handleDelivery(w.db, SECRET, { event: "issue_comment", signature: signatureOf(SECRET, raw) }, raw, safeEqual, slug);
};
const rows = (w: World) => w.db.prepare("SELECT comment_id, number, pr, weight, login, state, result, reply FROM github_commands ORDER BY comment_id").all().map((r) => ({ ...r }));

/** A fake gh that records the comments it posts. */
function ghFake(code = 0) {
  const posted: { args: string[]; body: string }[] = [];
  const exec: Exec = async (_cmd, args, opts) => {
    posted.push({ args, body: String(opts?.input ?? "") });
    return { code, stdout: code ? "" : "https://github.com/storytold/app/pull/1#issuecomment-9", stderr: code ? "boom" : "" };
  };
  return { posted, exec };
}
const deps = (w: World, o: Partial<CommandDeps> & { perm?: "ok" | "no" | "transient" } = {}): CommandDeps => ({
  querier: w.gh.querier, permission: async () => o.perm ?? "ok", ...o,
});
/** The item was read from GitHub at `at` (as the webhook's re-read or the poll write it). */
const readAt = (w: World, number: number, at: Date) =>
  w.db.prepare("INSERT INTO item_reads (repo, number, synced_at) VALUES ('app', ?, ?) ON CONFLICT (repo, number) DO UPDATE SET synced_at = excluded.synced_at").run(number, at.toISOString());
/** Drains after the re-reads: every commanded item was read just now. */
const drained = async (w: World, o: Parameters<typeof deps>[1] = {}) => {
  w.db.exec("DELETE FROM sync_requests");
  for (const { number } of w.db.prepare("SELECT DISTINCT number FROM github_commands").all() as { number: number }[]) readAt(w, number, new Date(Date.now() + 1000));
  return drainCommands(w.db, deps(w, o));
};

describe("parseCommand", () => {
  test("a line of its own addressed to the app, any case and spelling, with an optional weight", () => {
    assert.deepEqual(parseCommand(`@${SLUG} merge queue`, SLUG), { command: "merge-queue", weight: null });
    assert.deepEqual(parseCommand(`Looks good.\n\n  @Autocraft-Bot Merge-Queue!  \nthanks`, SLUG), { command: "merge-queue", weight: null });
    assert.deepEqual(parseCommand(`@${SLUG} mergequeue 8`, SLUG), { command: "merge-queue", weight: 8 });
    assert.deepEqual(parseCommand(`@${SLUG}[bot]: merge queue weight 3`, SLUG), { command: "merge-queue", weight: 3 });
    assert.deepEqual(parseCommand(`@${SLUG} merge queue 42`, SLUG), { command: "merge-queue", weight: 42 }, "the range is checked when it is carried out");
  });

  test("other apps, other words, quotes, code and text around the command do not count", () => {
    for (const body of [
      "@other-bot merge queue", `@${SLUG}x merge queue`, `please @${SLUG} merge queue`, `@${SLUG} merge queue now please`,
      `> @${SLUG} merge queue`, "```\n@" + SLUG + " merge queue\n```", `@${SLUG} merge`, "", `@${SLUG} merge queue 123`,
    ]) assert.equal(parseCommand(body, SLUG), null, body);
    assert.equal(parseCommand(`@${SLUG} merge queue`, ""), null);
    assert.equal(parseCommand(null, SLUG), null);
    assert.equal(parseCommand(`@a.b merge queue`, "a-b"), null, "the slug is matched literally");
  });

  test("a fence closes only with its own character, at least its length and nothing after it", () => {
    const cmd = `@${SLUG} merge queue`;
    for (const body of [
      "````\n```\n" + cmd + "\n````", // a shorter fence inside stays code
      "```\n~~~\n" + cmd + "\n```", // the other character stays code
      "```\n``` not a close\n" + cmd + "\n```", // text after the fence is no close
      "~~~~\n~~~\n" + cmd, // an unclosed fence runs to the end
    ]) assert.equal(parseCommand(body, SLUG), null, body);
    for (const body of ["````\ncode\n`````  \n" + cmd, "~~~ js\ncode\n~~~\n" + cmd, "```\n```\n" + cmd]) assert.notEqual(parseCommand(body, SLUG), null, body);
  });
});

describe("webhook", () => {
  test("a new comment with a command is queued once with the commenter, never its text; other comments queue none", () => {
    const w = fresh().pr(1);
    assert.equal(deliver(w, payload({ body: `@${SLUG} merge queue 7` })).status, 202);
    assert.equal(deliver(w, payload({ body: `@${SLUG} merge queue 7` })).status, 202, "a redelivery");
    deliver(w, payload({ body: `@${SLUG} merge queue`, comment: 5001, action: "edited" }));
    deliver(w, payload({ body: `@${SLUG} merge queue`, comment: 5002, type: "Bot" }));
    deliver(w, payload({ body: "just a comment", comment: 5003 }));
    deliver(w, payload({ body: `@${SLUG} merge queue`, comment: 5004, repo: "someoneelse/app" }));
    deliver(w, payload({ body: `@${SLUG} merge queue`, comment: 5005 }), null);
    deliver(w, payload({ body: `@${SLUG} merge queue`, comment: 5006, login: "bad login" }));
    assert.deepEqual(rows(w), [{ comment_id: 5000, number: 1, pr: 1, weight: 7, login: OPERATOR, state: "queued", result: null, reply: null }]);
    const cols = (w.db.prepare("SELECT name FROM pragma_table_info('github_commands')").all() as { name: string }[]).map((c) => c.name);
    assert.ok(!cols.includes("body"), "the comment's text has no column");
    assert.deepEqual(w.db.prepare("SELECT number FROM sync_requests").all().map((r) => ({ ...r })), [{ number: 1 }], "the item is still re-read");
  });
});

describe("drainCommands", () => {
  test("an operator with write access queues the PR as Queue items does, and the app answers in the thread", async () => {
    const w = fresh().pr(1);
    deliver(w, payload({ body: `@${SLUG} merge queue 7` }));
    const gh = ghFake();
    assert.equal(await drained(w, { exec: gh.exec }), 1);
    assert.equal(preapprovalOf(w.db, "app", 1)?.state, "review");
    assert.deepEqual(fastTrackList(w.db).map((f) => [f.number, f.weight]), [[1, 7]]);
    const [r] = rows(w) as { state: string; reply: string; result: string }[];
    assert.equal(r!.state, "done");
    assert.equal(r!.reply, "posted");
    assert.equal(gh.posted.length, 1);
    assert.deepEqual(gh.posted[0]!.args.slice(0, 5), ["pr", "comment", "1", "--repo", "storytold/app"]);
    assert.match(gh.posted[0]!.body, /^_Automated reply_\n\n@op Added to the merge queue; .*Fast-tracked with weight 7, 1 of 1\.$/);
    const audit = w.db.prepare("SELECT action, login, details FROM audit WHERE action IN ('preapproval', 'fasttrack-add', 'github-command', 'github-command-reply') ORDER BY rowid").all() as { action: string; login: string; details: string }[];
    assert.deepEqual(audit.map((a) => [a.action, a.login]), [["preapproval", OPERATOR], ["fasttrack-add", OPERATOR], ["github-command", OPERATOR], ["github-command-reply", OPERATOR]]);
    assert.equal(JSON.parse(audit[1]!.details).via, "github");
    assert.equal(JSON.parse(audit[3]!.details).state, "done");
    assert.equal(await drained(w, { exec: gh.exec }), 0, "nothing is left");
    assert.equal(gh.posted.length, 1);
  });

  test("the command waits until the item was read from GitHub after the comment, also when the re-read failed and its request is gone", async () => {
    const w = fresh().pr(1);
    readAt(w, 1, new Date(Date.now() - 60_000));
    deliver(w, payload({ body: `@${SLUG} merge queue` }));
    const gh = ghFake();
    assert.equal(await drainCommands(w.db, deps(w, { exec: gh.exec })), 0, "the re-read is still queued");
    w.db.exec("DELETE FROM sync_requests");
    assert.equal(await drainCommands(w.db, deps(w, { exec: gh.exec })), 0, "the request is gone but the last read is older than the comment");
    assert.equal(rows(w)[0]!.state, "queued");
    assert.equal(preapprovalOf(w.db, "app", 1), null);
    assert.deepEqual(w.db.prepare("SELECT number FROM sync_requests").all().map((r) => ({ ...r })), [{ number: 1 }], "the command asks for a new read");
    w.db.exec("DELETE FROM sync_requests");
    readAt(w, 1, new Date(Date.now() + 1000));
    assert.equal(await drainCommands(w.db, deps(w, { exec: gh.exec })), 0, "it looks again a minute after asking");
    const later = new Date(Date.now() + 2 * 60_000);
    assert.equal(await drainCommands(w.db, deps(w, { exec: gh.exec, now: () => later })), 1, "the new read came after the comment");
    assert.equal(preapprovalOf(w.db, "app", 1)?.state, "review");
  });

  test("a read stamped at the comment's own instant does not count: it may have started before it", async () => {
    const w = fresh().pr(1);
    deliver(w, payload({ body: `@${SLUG} merge queue` }));
    w.db.exec("DELETE FROM sync_requests");
    const at = (w.db.prepare("SELECT requested_at FROM github_commands").get() as { requested_at: string }).requested_at;
    readAt(w, 1, new Date(at));
    assert.equal(await drainCommands(w.db, deps(w, { exec: ghFake().exec })), 0);
    assert.equal(preapprovalOf(w.db, "app", 1), null);
    readAt(w, 1, new Date(Date.parse(at) + 1));
    assert.equal(await drainCommands(w.db, deps(w, { exec: ghFake().exec, now: () => new Date(Date.parse(at) + 2 * 60_000) })), 1, "one millisecond later counts");
  });

  test("an older read written while the permission is read from GitHub makes the command wait instead of queuing that head", async () => {
    const w = fresh().pr(1);
    deliver(w, payload({ body: `@${SLUG} merge queue` }));
    w.db.exec("DELETE FROM sync_requests");
    readAt(w, 1, new Date(Date.now() + 1000));
    // A reconcile that started before the comment lands while the permission read waits on GitHub: it sets the read time back.
    const permission = async () => { readAt(w, 1, new Date(Date.now() - 60_000)); return "ok" as const; };
    assert.equal(await drainCommands(w.db, { ...deps(w, { exec: ghFake().exec }), permission }), 0);
    assert.equal(rows(w)[0]!.state, "queued");
    assert.equal(preapprovalOf(w.db, "app", 1), null, "the older snapshot is not pre-approved");
    assert.deepEqual(w.db.prepare("SELECT number FROM sync_requests").all().map((r) => ({ ...r })), [{ number: 1 }], "the item is read again");
  });

  test("on an issue, the PR that closes it must be read after the comment too before it is queued", async () => {
    const w = fresh().issue(3).pr(4);
    w.db.prepare("UPDATE items SET closing_issues = '[3]' WHERE repo = 'app' AND number = 4").run();
    readAt(w, 4, new Date(Date.now() - 60_000));
    deliver(w, payload({ body: `@${SLUG} merge queue`, number: 3, pr: false }));
    w.db.exec("DELETE FROM sync_requests");
    readAt(w, 3, new Date(Date.now() + 1000));
    assert.equal(await drainCommands(w.db, deps(w, { exec: ghFake().exec })), 0, "the issue is fresh, its closing PR is not");
    assert.deepEqual(w.db.prepare("SELECT number FROM sync_requests").all().map((r) => ({ ...r })), [{ number: 4 }], "the PR is read again");
    assert.equal(preapprovalOf(w.db, "app", 4), null);
    readAt(w, 4, new Date(Date.now() + 1000));
    w.db.exec("DELETE FROM sync_requests");
    assert.equal(await drainCommands(w.db, deps(w, { exec: ghFake().exec, now: () => new Date(Date.now() + 2 * 60_000) })), 1);
    assert.equal(preapprovalOf(w.db, "app", 4)?.state, "review");
  });

  test("commands that wait for a re-read or a permission retry do not keep newer ones out of a drain", async () => {
    const w = fresh().pr(1).pr(2).pr(3);
    deliver(w, payload({ body: `@${SLUG} merge queue`, number: 1, comment: 7001 }));
    deliver(w, payload({ body: `@${SLUG} merge queue`, number: 2, comment: 7002 }));
    deliver(w, payload({ body: `@${SLUG} merge queue`, number: 3, comment: 7003 }));
    w.db.exec("DELETE FROM sync_requests");
    readAt(w, 2, new Date(Date.now() + 1000));
    readAt(w, 3, new Date(Date.now() + 1000));
    // #1 is not read yet; #2's permission cannot be told; with one GitHub call per drain #3 still gets its turn next.
    const perm = async (_q: unknown, _repo: string, _login: string) => "transient" as const;
    await drainCommands(w.db, { ...deps(w, { exec: ghFake().exec }), permission: perm, limit: 1 });
    assert.deepEqual(rows(w).map((r) => r.state), ["queued", "queued", "queued"]);
    await drainCommands(w.db, { ...deps(w, { exec: ghFake().exec }), limit: 1 });
    assert.deepEqual(rows(w).map((r) => r.state), ["queued", "queued", "done"], "#2 waits out its retry, #3 is carried out");
    const later = new Date(Date.now() + 2 * 60_000);
    await drainCommands(w.db, { ...deps(w, { exec: ghFake().exec }), limit: 1, now: () => later });
    assert.deepEqual(rows(w).map((r) => r.state), ["queued", "done", "done"], "after the retry wait #2 runs; its expiry still counts from the comment");
  });

  test("a stranger, or a login now held by another GitHub account, gets no answer and changes nothing", async () => {
    const w = fresh().pr(1);
    deliver(w, payload({ body: `@${SLUG} merge queue`, login: "stranger", id: 999 }));
    deliver(w, payload({ body: `@${SLUG} merge queue`, comment: 5001, id: 998 }));
    const gh = ghFake();
    await drained(w, { exec: gh.exec });
    assert.deepEqual(rows(w).map((r) => r.state), ["ignored", "ignored"]);
    assert.equal(gh.posted.length, 0);
    assert.equal(preapprovalOf(w.db, "app", 1), null);
  });

  test("Queue items' rule decides: a maintainer without maintainer writes, a viewer and an operator without write access are refused; so is an unbound login", async () => {
    const w = fresh().pr(1);
    w.db.prepare("INSERT INTO access (login, role, github_id) VALUES ('maint', 'maintainer', 202), ('view', 'viewer', 404), ('newop', 'operator', NULL)").run();
    deliver(w, payload({ body: `@${SLUG} merge queue`, login: "maint", id: 202 }));
    deliver(w, payload({ body: `@${SLUG} merge queue`, comment: 5001, login: "view", id: 404 }));
    deliver(w, payload({ body: `@${SLUG} merge queue`, comment: 5002, login: "newop", id: 303 }));
    const gh = ghFake();
    await drained(w, { exec: gh.exec });
    deliver(w, payload({ body: `@${SLUG} merge queue`, comment: 5003 }));
    await drained(w, { exec: gh.exec, perm: "no" });
    assert.deepEqual(rows(w).map((r) => r.state), ["refused", "refused", "refused", "refused"]);
    assert.equal(preapprovalOf(w.db, "app", 1), null);
    const bodies = gh.posted.map((p) => p.body);
    assert.match(bodies[0]!, /@maint Not added to the merge queue: only an operator, or a maintainer with write access where the app acts for them, queues items on app\.$/);
    assert.match(bodies[1]!, /@view Not added to the merge queue: only an operator, or a maintainer/);
    assert.match(bodies[2]!, /@newop Not added to the merge queue: sign in to the AutoCraft dashboard once first/);
    assert.match(bodies[3]!, /@op Not added to the merge queue: no write access to storytold\/app/);
    assert.equal((w.db.prepare("SELECT github_id FROM access WHERE login = 'newop'").get() as { github_id: number | null }).github_id, null, "a comment never binds an id");
  });

  test("a maintainer who settles decisions on the repo queues, as with Queue items; without write access they do not", async () => {
    const w = fresh().pr(1).pr(2);
    w.db.prepare("INSERT INTO access (login, role, github_id) VALUES ('maint', 'maintainer', 202)").run();
    w.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('maintainer_writes', '1'), ('github_identity', 'app')").run();
    deliver(w, payload({ body: `@${SLUG} merge queue`, login: "maint", id: 202, number: 2, comment: 6000 }));
    await drained(w, { exec: ghFake().exec, perm: "no" });
    assert.equal(rows(w)[0]!.state, "refused");
    assert.equal(preapprovalOf(w.db, "app", 2), null);
    deliver(w, payload({ body: `@${SLUG} merge queue`, login: "maint", id: 202, comment: 6001 }));
    await drained(w, { exec: ghFake().exec });
    assert.equal(rows(w)[1]!.state, "done");
    assert.equal(preapprovalOf(w.db, "app", 1)?.by, "maint");
  });

  test("queueAdd's refusal is the answer; an unclear permission keeps the command for later", async () => {
    const w = fresh(["merge"]).pr(1);
    deliver(w, payload({ body: `@${SLUG} merge queue` }));
    const gh = ghFake();
    await drained(w, { exec: gh.exec, perm: "transient" });
    assert.equal(rows(w)[0]!.state, "queued");
    assert.equal(gh.posted.length, 0);
    await drained(w, { exec: gh.exec });
    assert.equal(rows(w)[0]!.state, "queued", "the retry waits a minute");
    await drained(w, { exec: gh.exec, now: () => new Date(Date.now() + 2 * 60_000) });
    assert.equal(rows(w)[0]!.state, "refused");
    assert.match(gh.posted[0]!.body, /@op Not added to the merge queue: merging is not approved for app\.$/);
  });

  test("an issue is fast-tracked; an answer that fails is recorded and not posted again", async () => {
    const w = fresh().issue(3);
    deliver(w, payload({ body: `@${SLUG} merge queue`, number: 3, pr: false }));
    const gh = ghFake(1);
    await drained(w, { exec: gh.exec });
    assert.deepEqual(fastTrackList(w.db).map((f) => f.number), [3]);
    assert.equal(gh.posted[0]!.args[0], "issue");
    assert.deepEqual(rows(w).map((r) => [r.state, r.reply]), [["done", "failed"]]);
    await drained(w, { exec: gh.exec });
    assert.equal(gh.posted.length, 1);
  });

  test("a command not carried out within an hour is dropped unanswered", async () => {
    const w = fresh().pr(1);
    deliver(w, payload({ body: `@${SLUG} merge queue` }));
    const gh = ghFake();
    await drained(w, { exec: gh.exec, now: () => new Date(Date.now() + 2 * 3600_000) });
    assert.deepEqual(rows(w).map((r) => r.state), ["expired"]);
    assert.equal(gh.posted.length, 0);
  });

  test("a command exactly an hour old has expired", async () => {
    const w = fresh().pr(1);
    deliver(w, payload({ body: `@${SLUG} merge queue` }));
    const at = Date.parse((w.db.prepare("SELECT requested_at FROM github_commands").get() as { requested_at: string }).requested_at);
    await drained(w, { exec: ghFake().exec, now: () => new Date(at + 3600_000) });
    assert.deepEqual(rows(w).map((r) => r.state), ["expired"]);
    assert.equal(preapprovalOf(w.db, "app", 1), null);
  });

  test("the hour can run out while GitHub answers the permission read: then nothing is queued", async () => {
    const w = fresh().pr(1);
    deliver(w, payload({ body: `@${SLUG} merge queue` }));
    const gh = ghFake();
    // 59 minutes when the drain starts, 61 once the permission read is back.
    let at = Date.now() + 59 * 60_000;
    const permission = async () => { at = Date.now() + 61 * 60_000; return "ok" as const; };
    w.db.exec("DELETE FROM sync_requests");
    readAt(w, 1, new Date(Date.now() + 1000));
    await drainCommands(w.db, { ...deps(w, { exec: gh.exec, now: () => new Date(at) }), permission });
    assert.deepEqual(rows(w).map((r) => r.state), ["expired"]);
    assert.equal(preapprovalOf(w.db, "app", 1), null);
    assert.equal(gh.posted.length, 0);
  });
});
