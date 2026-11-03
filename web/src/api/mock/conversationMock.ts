import type { Api } from "../client";
import type { Conversation, ConversationCard, ConversationTurn, User } from "../types";
import { NOW } from "./fixtures";

const MIN = 60_000;
const at = (min: number) => new Date(NOW - min * MIN).toISOString();
const REF = "designcraft#1484";

const COMMENT =
  "Thanks for adding Hungarian. craft-i18n already ships a `hu` language pack that craft-proof reads, so the dictionary and pattern files don't need to be committed here. Could you load the pack instead?";

const card = (c: Partial<ConversationCard> & Pick<ConversationCard, "id" | "kind" | "title" | "state">): ConversationCard => c;

function seed(): ConversationTurn[] {
  return [
    {
      id: 1,
      kind: "opus",
      login: "opus",
      at: at(42),
      body: "This adds Hungarian by committing the LibreOffice dictionary and TeX patterns (~270k lines). craft-i18n already ships a `hu` language pack that craft-proof in craft-libs reads; DesignCraft doesn't use craft-proof yet. I'd ask the author to use the pack instead.",
      actions: [card({ id: 1, kind: "comment", title: `Post comment on ${REF}`, text: COMMENT, state: "proposed" })],
      notes: [],
    },
    {
      id: 2,
      kind: "opus",
      login: "opus",
      at: at(41),
      body: "I would not merge it as it stands.",
      actions: [card({ id: 2, kind: "label", title: "Add label: needs changes", state: "proposed" })],
      notes: ["Dropped a card to close the PR: closing needs a comment first."],
    },
    { id: 3, kind: "operator", login: "mosswood", at: at(30), body: "ok but check the pack actually loads first", actions: [], notes: [], status: "answered" },
    {
      id: 4,
      kind: "opus",
      login: "opus",
      at: at(29),
      body: "Checked: `craft-i18n/packs/hu` loads through craft-proof's `load_pack` with the same hyphenation patterns. The pack is the same data, so nothing is lost.\n\nI can also put it in the Backlog or mark it a duplicate of the earlier Hungarian request.",
      actions: [
        card({ id: 3, kind: "backlog", title: `Move ${REF} to the Backlog`, state: "done", done: { at: at(20), link: "", label: "Backlog" }, by: "mosswood", at: at(20) }),
        card({ id: 4, kind: "comment", title: `Post comment on ${REF}`, text: "Loading the pack works with the same patterns, so no data needs to be added here.", state: "failed", error: "Comment approval is off for designcraft.", by: "mosswood", at: at(19) }),
        card({ id: 5, kind: "duplicate", title: `Close ${REF} as a duplicate of designcraft#1102`, state: "dismissed", by: "mosswood", at: at(18) }),
      ],
      notes: [],
    },
    { id: 5, kind: "system", login: "system", at: at(18), body: "mosswood ran: Move designcraft#1484 to the Backlog. mosswood dismissed: Close designcraft#1484 as a duplicate of designcraft#1102.", actions: [], notes: [] },
  ];
}

/** In-memory conversations. Only designcraft#1484 starts with one; an operator's message is answered after a few seconds. */
export function createConversationMock(me: User, changed: () => void): Pick<Api, "conversations"> {
  const store = new Map<string, Conversation>([[REF, { repo: "designcraft", number: 1484, exists: true, pending: false, startedBy: "opus", turns: seed() }]]);
  let nextId = 100;
  const open = (repo: string, n: number): Conversation => {
    const k = `${repo}#${n}`;
    let c = store.get(k);
    if (!c) store.set(k, (c = { repo, number: n, exists: false, pending: false, startedBy: null, turns: [] }));
    return c;
  };
  const cards = () => [...store.values()].flatMap((c) => c.turns.flatMap((t) => t.actions));
  const find = (id: number) => {
    const c = cards().find((x) => x.id === id);
    if (!c) throw new Error(`no card ${id}`);
    return c;
  };
  const need = () => {
    if (me.role !== "operator") throw new Error("only operators write in conversations");
  };
  const snap = <T,>(v: T, ms = 40) => new Promise<T>((r) => setTimeout(() => r(structuredClone(v)), ms));
  return {
    conversations: {
      get: (repo, n) => snap(open(repo, n)),
      async say(repo, n, text) {
        need();
        const c = open(repo, n);
        if (c.pending) throw new Error("Opus has not answered the last message yet");
        const t: ConversationTurn = { id: nextId++, kind: "operator", login: me.login, at: new Date().toISOString(), body: text, actions: [], notes: [], status: "pending" };
        Object.assign(c, { exists: true, pending: true, startedBy: c.startedBy ?? me.login });
        c.turns.push(t);
        changed();
        setTimeout(() => {
          t.status = "answered";
          c.pending = false;
          c.turns.push({ id: nextId++, kind: "opus", login: "opus", at: new Date().toISOString(), body: "I read that. The pack and the committed files carry the same patterns, so asking the author to load the pack still holds.", actions: [], notes: [] });
          changed();
        }, 5000);
        return snap(c);
      },
      async editCard(id, text) {
        need();
        const k = find(id);
        Object.assign(k, { text, edited: true });
        changed();
        return snap(k);
      },
      async doCard(id) {
        need();
        const k = find(id);
        k.state = "running";
        changed();
        setTimeout(() => {
          Object.assign(k, { state: "done", by: me.login, at: new Date().toISOString(), done: { at: new Date().toISOString(), link: k.kind === "comment" ? "#comment" : "", label: k.kind === "comment" ? `Comment on ${REF}` : k.title } });
          changed();
        }, 600);
        return snap(k);
      },
      async dismissCard(id) {
        need();
        const k = find(id);
        Object.assign(k, { state: "dismissed", by: me.login, at: new Date().toISOString() });
        changed();
        return snap(k);
      },
    },
  };
}
