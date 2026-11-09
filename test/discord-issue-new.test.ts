// The Discord new-issue helper: a duplicate ends the session, "None of these" goes through the follow-up questions to a
// checked draft and a prefilled GitHub link, the daily cap builds the link from the form alone, and the rate limit refuses.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { connect } from "../src/db.ts";
import type { Embedder } from "../src/embed/model.ts";
import { toBlob } from "../src/embed/store.ts";
import { VectorIndex } from "../src/embed/vectors.ts";
import { Interactions } from "../src/discord/interactions.ts";
import { sanitize } from "../src/discord/issue-draft.ts";
import { installIssueNew, type IssueAsk } from "../src/discord/issue-new.ts";
import { DiscordKeys } from "../src/discord/keys.ts";
import type { CallbackData, CommandDef, DiscordRest, EditBody, MessageBody } from "../src/discord/rest.ts";
import { Search, type Ask } from "../src/discord/search.ts";
import { installSearchCommands } from "../src/discord/search-commands.ts";
import { useTestAccount } from "./accounts-fixture.ts";
import { SCRATCH } from "./scratch.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "discord-issue-"));
const db = connect(join(dir, "d.db"));
const keys = new DiscordKeys("k".repeat(40));
useTestAccount(db);
after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

const VOCAB = ["webp", "export", "quality", "dark", "mode", "layers"];
const embedder: Embedder = {
  id: "fake", dim: VOCAB.length,
  async embed(texts) {
    return texts.map((t) => {
      const v = new Float32Array(VOCAB.length);
      VOCAB.forEach((w, i) => { if (t.toLowerCase().includes(w)) v[i] = 1; });
      const n = Math.hypot(...v) || 1;
      return v.map((x) => x / n);
    });
  },
};

class FakeRest implements DiscordRest {
  callbacks: { type: number; data?: CallbackData }[] = [];
  edits: EditBody[] = [];
  async createMessage(_c: string, _b: MessageBody) { return { id: "m" }; }
  async editMessage() {}
  async deleteMessage() {}
  async interactionCallback(_i: string, _t: string, type: 4 | 5 | 8 | 9, data?: CallbackData) { this.callbacks.push({ type, data }); }
  async editInteractionResponse(_a: string, _t: string, body: EditBody) { this.edits.push(body); }
  async overwriteGuildCommands(_a: string, _g: string, _c: CommandDef[]) {}
}

const rest = new FakeRest();
const ix = new Interactions(rest, (l) => assert.fail(l));
const pick: Ask = async () => (pickReply);
let pickReply = JSON.stringify({ picks: [{ ref: "photocraft#1", reason: "Same problem" }] });
const calls: { id: string; input: unknown }[] = [];
let draftReply: string | null = JSON.stringify({ title: "WebP export ignores quality", body: "Quality has no effect. See https://evil.example/x and https://github.com/storytold/photocraft/issues/1 ping @everyone <@123>" });
let questionsReply: string | null = JSON.stringify({ ask: ["steps", "env", "bogus"] });
const ask = (async (_db: unknown, id: string, input: unknown) => { calls.push({ id, input }); return id === "discord.issue-questions" ? questionsReply : draftReply; }) as IssueAsk;
const search = new Search({ db, embedder, index: new VectorIndex(embedder), log: () => {}, ask: pick });
installSearchCommands(ix, { db, keys, search });
installIssueNew(ix, { db, keys, search, log: (l) => assert.fail(l), ask });

let n = 0;
const send = async (type: number, user: string, data: unknown, channel = "c1") => {
  rest.callbacks.length = 0; rest.edits.length = 0;
  ix.dispatch("INTERACTION_CREATE", { id: `i${++n}`, token: "t", type, application_id: "app1", channel_id: channel, member: { user: { id: user } }, data });
  for (let k = 0; k < 50 && !(rest.callbacks.length && (rest.callbacks.at(-1)!.type !== 5 || rest.edits.length)); k++) await new Promise((r) => setTimeout(r, 5));
};
const modalId = (): string => rest.callbacks.find((c) => c.type === 9)!.data!.custom_id!;
const submit = (user: string, custom_id: string, values: Record<string, string>) =>
  send(5, user, { custom_id, components: Object.entries(values).map(([id, value]) => ({ type: 1, components: [{ type: 4, custom_id: id, value }] })) });
const press = (user: string, custom_id: string) => send(3, user, { custom_id });
const newCmd = (user: string, channel = "c1") => send(2, user, { name: "autocraft", type: 1, options: [{ name: "new-issue", type: 1, options: [{ name: "repo", type: 3, value: "photocraft" }] }] }, channel);
const rows = (b: EditBody) => (b.components as { components: { label: string; custom_id?: string; url?: string }[] }[]).flatMap((r) => r.components);

before(async () => {
  db.prepare("INSERT OR IGNORE INTO tracked_repos (name) VALUES ('photocraft')").run();
  db.prepare("INSERT INTO repos (name, owner, visibility) VALUES ('photocraft', 'storytold', 'public') ON CONFLICT(name) DO UPDATE SET visibility = excluded.visibility").run();
  const recent = new Date().toISOString();
  db.prepare("INSERT INTO items (repo, number, kind, state, title, body, url) VALUES ('photocraft', 1, 'issue', 'OPEN', 'Export to WebP ignores the quality setting', '', 'https://github.com/storytold/photocraft/issues/1')").run();
  db.prepare("INSERT INTO item_embeddings (repo, number, model, hash, vec, at) VALUES ('photocraft', 1, 'fake', 'h', ?, ?)").run(toBlob((await embedder.embed(["Export to WebP ignores the quality setting"], "item"))[0]!), recent);
});

describe("new issue helper", () => {
  test("a duplicate: That's it shows the issue link and ends the session", async () => {
    await newCmd("u1");
    assert.equal(rest.callbacks[0]!.type, 9);
    const form = modalId();
    await submit("u1", form, { title: "webp export", description: "quality slider does nothing" });
    const b = rest.edits[0]!;
    assert.match(b.content!, /photocraft#1 Export to WebP/);
    const it = rows(b).find((x) => x.label === "That's it")!;
    await press("u1", it.custom_id!);
    assert.match(rest.edits[0]!.content!, /photocraft#1: https:\/\/github\.com\/storytold\/photocraft\/issues\/1/);
    await press("u1", rows(b).find((x) => x.label === "None of these")!.custom_id!);
    assert.match(rest.callbacks[0]!.data!.content!, /expired/);
  });

  test("another person cannot press someone's buttons", async () => {
    await newCmd("u2");
    await submit("u2", modalId(), { title: "webp export", description: "quality slider does nothing" });
    await press("u3", rows(rest.edits[0]!).find((x) => x.label === "None of these")!.custom_id!);
    assert.match(rest.callbacks[0]!.data!.content!, /expired/);
  });

  test("None of these: questions from the fixed list, then a checked draft and a prefilled link", async () => {
    calls.length = 0;
    await newCmd("u4");
    await submit("u4", modalId(), { title: "webp export", description: "quality slider does nothing" });
    const noneId = rows(rest.edits[0]!).find((x) => x.label === "None of these")!.custom_id!;
    await press("u4", noneId);
    const modal = rest.callbacks[0]!;
    assert.equal(modal.type, 9);
    const fields = (modal.data as unknown as { components: { components: { custom_id: string; label: string }[] }[] }).components.map((r) => r.components[0]!);
    assert.deepEqual(fields.map((f) => f.custom_id), ["steps", "env"]);
    await submit("u4", modal.data!.custom_id!, { steps: "Export twice", env: "1.0 on Linux" });
    const out = rest.edits[0]!;
    const link = /\[Open on GitHub\]\(<([^>]+)>\)/.exec(out.content!)![1]!;
    const u = new URL(link);
    assert.equal(`${u.origin}${u.pathname}`, "https://github.com/storytold/photocraft/issues/new");
    assert.ok(link.length <= 1500);
    assert.equal(u.searchParams.get("title"), "WebP export ignores quality");
    const body = u.searchParams.get("body")!;
    assert.match(body, /issues\/1/);
    assert.doesNotMatch(body, /evil\.example|@|<@/);
    assert.match(body, /\[link removed\]/);
    // The model got the person's text only as a JSON data block through the registered prompt input.
    assert.deepEqual((calls.find((c) => c.id === "discord.issue-draft")!.input as { answers: unknown[] }).answers, [{ question: "Steps to reproduce", answer: "Export twice" }, { question: "Version and platform", answer: "1.0 on Linux" }]);
    // Pressing None of these again, or sending the answers again, makes no new model call.
    const before = calls.length;
    await press("u4", noneId);
    assert.match(rest.callbacks[0]!.data!.content!, /already used/);
    await submit("u4", modal.data!.custom_id!, { steps: "again" });
    assert.match(rest.edits[0]!.content!, /already used/);
    assert.equal(calls.length, before);
    await press("u4", "inewi:bogus:x");
    assert.match(rest.callbacks[0]!.data!.content!, /expired/);
    // Edit reopens the draft in a form; the result replaces the draft.
    await press("u4", rows(out).find((x) => x.label === "Edit")!.custom_id!);
    const edit = rest.callbacks[0]!;
    assert.equal(edit.type, 9);
    await submit("u4", edit.data!.custom_id!, { title: "Better title", body: "Own body" });
    assert.match(decodeURIComponent(/title=([^&]+)/.exec(rest.edits[0]!.content!)![1]!), /Better title/);
    // No prompt or reply text of the issue calls is left behind.
    assert.equal((db.prepare("SELECT COUNT(*) AS c FROM agent_run_texts WHERE run_id IN (SELECT id FROM agent_runs WHERE step = 'discord-issue')").get() as { c: number }).c, 0);
  });

  test("a long draft is trimmed with a note so the link fits", async () => {
    draftReply = JSON.stringify({ title: "Long", body: "word ".repeat(600) });
    await newCmd("u5");
    await submit("u5", modalId(), { title: "dark mode", description: "layers panel stays light" });
    await press("u5", rows(rest.edits[0]!).find((x) => x.label === "None of these")!.custom_id!);
    await submit("u5", modalId(), {});
    const link = /\[Open on GitHub\]\(<([^>]+)>\)/.exec(rest.edits[0]!.content!)![1]!;
    assert.ok(link.length <= 1500);
    assert.match(new URL(link).searchParams.get("body")!, /Text trimmed to fit the link/);
    assert.ok(rest.edits[0]!.content!.length <= 2000);
  });

  test("over the daily cap no model is asked and the link is built from the form", async () => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('discord_issue_daily_usd', '0') ON CONFLICT(key) DO UPDATE SET value = '0'").run();
    calls.length = 0;
    await newCmd("u6");
    await submit("u6", modalId(), { title: "dark mode", description: "layers panel stays light" });
    await press("u6", rows(rest.edits[0]!).find((x) => x.label === "None of these")!.custom_id!);
    assert.equal(rest.callbacks.at(-1)!.type, 5);
    assert.equal(calls.length, 0);
    const link = /\[Open on GitHub\]\(<([^>]+)>\)/.exec(rest.edits[0]!.content!)![1]!;
    assert.equal(new URL(link).searchParams.get("title"), "dark mode");
    assert.match(new URL(link).searchParams.get("body")!, /layers panel stays light/);
    db.prepare("DELETE FROM settings WHERE key = 'discord_issue_daily_usd'").run();
  });

  test("a person gets three sessions an hour", async () => {
    for (let k = 0; k < 3; k++) { await newCmd("u7"); assert.equal(rest.callbacks[0]!.type, 9); }
    await newCmd("u7");
    assert.equal(rest.callbacks[0]!.type, 4);
    assert.match(rest.callbacks[0]!.data!.content!, /Too many/);
  });
});

test("the sanitizer removes foreign link targets and hidden comments", () => {
  const repos = [{ owner: "storytold", name: "photocraft" }];
  const out = sanitize("[a](//evil.example/x) ![b](/rel.png) [c](https://github.com/storytold/photocraft/issues/2) <!-- hidden", repos);
  assert.doesNotMatch(out, /evil|rel\.png|hidden/);
  assert.match(out, /issues\/2/);
  assert.equal(sanitize("x <!-- c --> y", repos), "x  y");
});
