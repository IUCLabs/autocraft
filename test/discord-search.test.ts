// Discord issue search: ping replies, the model pick limited to the candidates, the daily cap, deleting a reply with its
// ping, the commands, and that no message text reaches the database.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { connect } from "../src/db.ts";
import type { Embedder } from "../src/embed/model.ts";
import { toBlob } from "../src/embed/store.ts";
import { VectorIndex } from "../src/embed/vectors.ts";
import { Interactions } from "../src/discord/interactions.ts";
import { DiscordKeys } from "../src/discord/keys.ts";
import { Pings } from "../src/discord/pings.ts";
import type { CommandDef, DiscordRest, EditBody, MessageBody } from "../src/discord/rest.ts";
import { Search, type Ask } from "../src/discord/search.ts";
import { installSearchCommands } from "../src/discord/search-commands.ts";
import { SCRATCH } from "./scratch.ts";

mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(join(SCRATCH, "discord-search-"));
const db = connect(join(dir, "d.db"));
const keys = new DiscordKeys("k".repeat(40));
after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const VOCAB = ["webp", "export", "quality", "dark", "mode", "layers", "crash"];
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
  sent: { channelId: string; body: MessageBody; id: string }[] = [];
  deleted: string[] = [];
  callbacks: { type: number; ephemeral?: boolean }[] = [];
  edits: EditBody[] = [];
  commands: { guildId: string; commands: CommandDef[] }[] = [];
  async createMessage(channelId: string, body: MessageBody) { const id = `r${this.sent.length + 1}`; this.sent.push({ channelId, body, id }); return { id }; }
  async editMessage() {}
  async deleteMessage(_c: string, id: string) { this.deleted.push(id); }
  async interactionCallback(_i: string, _t: string, type: 4 | 5, data?: { ephemeral?: boolean }) { this.callbacks.push({ type, ephemeral: data?.ephemeral }); }
  async editInteractionResponse(_a: string, _t: string, body: EditBody) { this.edits.push(body); }
  async overwriteGuildCommands(_a: string, guildId: string, commands: CommandDef[]) { this.commands.push({ guildId, commands }); }
}

let asked: unknown[] = [];
let reply = (): string | null => JSON.stringify({ picks: [{ ref: "photocraft#1", reason: "Same WebP quality problem" }, { ref: "evil#9", reason: "not a candidate" }, { ref: "photocraft#3", reason: "Closed with the original export" }] });
const ask: Ask = async (_db, input) => { asked.push(input); return reply(); };

const rest = new FakeRest();
const search = new Search({ db, embedder, index: new VectorIndex(embedder), log: () => {}, ask });
const pings = new Pings({ db, keys, rest, search, log: (l) => assert.fail(l) });

const QUESTION = "zebra-unique webp export quality is ignored";
const msg = (id: string, over: Record<string, unknown> = {}) => ({
  id, channel_id: "c1", guild_id: "g1", content: "<@bot1> is this known?", type: 19, author: { id: "u1" }, mentions: [{ id: "bot1" }],
  message_reference: { message_id: "q1" }, referenced_message: { content: QUESTION }, ...over,
});

before(async () => {
  db.prepare("INSERT OR IGNORE INTO tracked_repos (name) VALUES ('photocraft'), ('secret')").run();
  db.prepare("INSERT INTO repos (name, owner, visibility) VALUES ('photocraft', 'storytold', 'public'), ('secret', 'storytold', 'private') ON CONFLICT(name) DO UPDATE SET visibility = excluded.visibility").run();
  db.prepare("INSERT INTO discord_channels (channel_id, guild_id, guild_name, name, watched, default_repo) VALUES ('c1', 'g1', 'G', 'dev', 1, 'photocraft'), ('c2', 'g1', 'G', 'off', 0, NULL)").run();
  const recent = new Date(Date.now() - 5 * 86_400_000).toISOString();
  const item = db.prepare("INSERT INTO items (repo, number, kind, state, state_reason, closed_at, title, body, url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const emb = db.prepare("INSERT INTO item_embeddings (repo, number, model, hash, vec, at) VALUES (?, ?, 'fake', 'h', ?, ?)");
  const rows: [string, number, string, string, string | null, string | null, string][] = [
    ["photocraft", 1, "issue", "OPEN", null, null, "Export to WebP ignores the quality setting"],
    ["photocraft", 2, "issue", "OPEN", null, null, "Dark mode for the layers panel"],
    ["photocraft", 3, "issue", "CLOSED", "COMPLETED", recent, "Add WebP export"],
    ["photocraft", 4, "pr", "OPEN", null, null, "WebP export quality fix"],
    ["photocraft", 5, "issue", "CLOSED", "NOT_PLANNED", recent, "WebP export quality in another format"],
    ["secret", 1, "issue", "OPEN", null, null, "WebP export quality in a private repo"],
  ];
  for (const [repo, n, kind, state, reason, closed, title] of rows) {
    item.run(repo, n, kind, state, reason, closed, title, "", `https://github.com/storytold/${repo}/${kind === "pr" ? "pull" : "issues"}/${n}`);
    emb.run(repo, n, toBlob((await embedder.embed([title], "item"))[0]!), recent);
  }
  pings.dispatch("READY", { user: { id: "bot1" } });
});

describe("ping replies", () => {
  test("a reply-ping searches the quoted text and replies once, publicly, with link buttons and no mentions", async () => {
    pings.dispatch("MESSAGE_CREATE", msg("p1"));
    pings.dispatch("MESSAGE_CREATE", msg("p1"));
    await pings.idle();
    assert.equal(rest.sent.length, 1);
    const { body } = rest.sent[0]!;
    assert.deepEqual(body.allowed_mentions, { parse: [] });
    assert.deepEqual(body.message_reference, { message_id: "p1", fail_if_not_exists: false });
    assert.match(body.content!, /photocraft#1 Export to WebP ignores the quality setting\n> Same WebP quality problem/);
    assert.match(body.content!, /photocraft#3 Add WebP export \(closed\)/);
    const buttons = (body.components![0] as { components: { style: number; label: string; url: string }[] }).components;
    assert.deepEqual(buttons.map((b) => b.label), ["photocraft#1", "photocraft#3", "File a new issue"]);
    assert.ok(buttons.every((b) => b.style === 5));
    assert.equal(buttons[2]!.url, `https://github.com/storytold/photocraft/issues/new?title=${encodeURIComponent(QUESTION)}`);
    // The model saw the quoted text, not the ping, and only public open issues and recently completed ones.
    const input = asked[0] as { question: string; candidates: { ref: string; closed: boolean }[] };
    assert.equal(input.question, QUESTION);
    assert.deepEqual(input.candidates.map((c) => c.ref).sort(), ["photocraft#1", "photocraft#2", "photocraft#3"]);
  });

  test("bots, unwatched channels and edits get no reply", async () => {
    const before = rest.sent.length;
    pings.dispatch("MESSAGE_CREATE", msg("p2", { author: { id: "b", bot: true } }));
    pings.dispatch("MESSAGE_CREATE", msg("p3", { channel_id: "c2" }));
    pings.dispatch("MESSAGE_UPDATE", msg("p1"));
    pings.dispatch("MESSAGE_CREATE", msg("p4", { mentions: [] }));
    await pings.idle();
    assert.equal(rest.sent.length, before);
  });

  test("the pick is limited to the candidates", async () => {
    reply = () => JSON.stringify({ picks: [{ ref: "evil#9", reason: "invented" }, { ref: "photocraft#99", reason: "invented" }] });
    pings.dispatch("MESSAGE_CREATE", msg("p5", { referenced_message: { content: "crash in layers" } }));
    await pings.idle();
    const sent = rest.sent.at(-1)!.body.content!;
    assert.match(sent, /No matching issue found/);
    assert.doesNotMatch(sent, /evil|#99/);
  });

  test("over the daily cap the closest issues come from the embeddings, without a model call", async () => {
    db.prepare(`INSERT INTO agent_runs (step, stage, prompt_id, prompt_version, provider, model, items, item_count, state, started_at, cost_usd)
      VALUES ('discord-search', 3, 'discord.search', '1', 'claude', 'haiku', '[]', 0, 'done', ?, 2.5)`).run(new Date().toISOString());
    const calls = asked.length;
    pings.dispatch("MESSAGE_CREATE", msg("p6", { referenced_message: { content: "webp export quality" } }));
    await pings.idle();
    assert.equal(asked.length, calls);
    const sent = rest.sent.at(-1)!.body.content!;
    assert.match(sent, /photocraft#1 /);
    assert.doesNotMatch(sent, />/);
    db.prepare("DELETE FROM agent_runs WHERE step = 'discord-search'").run();
  });

  test("deleting the ping, or the quoted message, deletes our reply", async () => {
    reply = () => null;
    pings.dispatch("MESSAGE_CREATE", msg("p7", { message_reference: { message_id: "q7" }, referenced_message: { content: "webp export quality" } }));
    pings.dispatch("MESSAGE_CREATE", msg("p8", { message_reference: { message_id: "q8" }, referenced_message: { content: "webp export quality" }, author: { id: "u2" } }));
    await pings.idle();
    const idOf = (i: number) => rest.sent[i]!.id;
    const n = rest.sent.length;
    pings.dispatch("MESSAGE_DELETE", { id: "p7" });
    pings.dispatch("MESSAGE_DELETE", { id: "q8" });
    await pings.idle();
    assert.deepEqual(rest.deleted.sort(), [idOf(n - 2), idOf(n - 1)].sort());
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM discord_replies WHERE ping_hash IN (?, ?)").get(keys.hash("message", "p7"), keys.hash("message", "p8")) as { n: number }).n, 0);
  });

  test("no question text is stored in any table", () => {
    const dump = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
      .map((t) => JSON.stringify((db.prepare(`SELECT * FROM "${t.name}"`).all() as object[]).map((r) => Object.values(r).map((v) => (v instanceof Uint8Array ? Buffer.from(v).toString("latin1") : v)))))
      .join("\n");
    for (const needle of ["zebra-unique", "is this known", "crash in layers"]) assert.ok(!dump.includes(needle), needle);
  });
});

describe("commands", () => {
  test("a slash command is deferred as ephemeral, then edited with the result; guild commands register once", async () => {
    const ix = new Interactions(rest, (l) => assert.fail(l));
    installSearchCommands(ix, { db, keys, search });
    reply = () => JSON.stringify({ picks: [{ ref: "photocraft#2", reason: "Same panel" }] });
    ix.dispatch("READY", { application: { id: "app1" } });
    ix.dispatch("GUILD_CREATE", { id: "g1" });
    ix.dispatch("GUILD_CREATE", { id: "g1" });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(rest.commands.length, 1);
    assert.deepEqual(rest.commands[0]!.commands.map((c) => [c.name, c.type]), [["issue", 1], ["Find issue", 3]]);
    ix.dispatch("INTERACTION_CREATE", { id: "i1", token: "t", type: 2, application_id: "app1", channel_id: "c1", member: { user: { id: "u9" } }, data: { name: "issue", type: 1, options: [{ name: "search", type: 1, options: [{ name: "query", type: 3, value: "dark mode layers" }] }] } });
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(rest.callbacks.at(-1), { type: 5, ephemeral: true });
    assert.match(rest.edits.at(-1)!.content!, /photocraft#2 Dark mode for the layers panel\n> Same panel/);
  });
});
