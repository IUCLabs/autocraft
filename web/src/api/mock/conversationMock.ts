import type { Api } from "../client";
import type { Conversation, ConversationCard, ConversationTurn, User } from "../types";
import { NOW } from "./fixtures";

const MIN = 60_000;
const at = (min: number) => new Date(NOW - min * MIN).toISOString();
const REF = "designcraft#1484";

const card = (c: Partial<ConversationCard> & Pick<ConversationCard, "id" | "kind" | "title" | "state">): ConversationCard => ({ label: LABELS[c.kind], steps: [], ...c });
const LABELS: Record<ConversationCard["kind"], string> = { resolution: "Do it", comment: "Post comment", answer: "Answer", label: "Add label", backlog: "Move to Backlog", resolve: "Close decision", duplicate: "Close as duplicate", close: "Close issue" };

function seed(): ConversationTurn[] {
  return [
    {
      id: 1,
      kind: "opus",
      login: "opus",
      at: at(42),
      body: "This adds Hungarian by committing the LibreOffice dictionary and TeX patterns (~270k lines). craft-i18n already ships a `hu` language pack that craft-proof in craft-libs reads; DesignCraft doesn't use craft-proof yet. I'd ask the author to use the pack instead.",
      actions: [],
      notes: [],
    },
    {
      id: 2,
      kind: "opus",
      login: "opus",
      at: at(41),
      body: "I would not merge it as it stands.",
      actions: [],
      notes: ["Dropped a card to close the PR: closing needs a comment first."],
    },
    { id: 3, kind: "operator", login: "mosswood", at: at(30), body: "ok but check the pack actually loads first", actions: [], notes: [], status: "answered" },
    {
      id: 4,
      kind: "opus",
      login: "opus",
      at: at(29),
      body: "Checked: `craft-i18n/packs/hu` loads through craft-proof's `load_pack` with the same hyphenation patterns. The pack is the same data, so nothing is lost.\n\nI can also put it in the Backlog or mark it a duplicate of the earlier Hungarian request.",
      actions: [],
      notes: [],
    },
    { id: 5, kind: "system", login: "system", at: at(18), body: 'mosswood ran the card: Add the label needs changes. Label added. Note: hold until the pack check is done', actions: [], notes: [] },
    { id: 7, kind: "system", login: "system", at: at(12), body: 'kiri-n answered "Is ruler snapping for gradient stops in scope?" with "Take": fits the editor roadmap', actions: [], notes: [] },
    {
      id: 6,
      kind: "opus",
      login: "opus",
      at: at(5),
      body: "The `hu` pack was merged in designcraft#1301, so the data this PR adds is already covered. I would post a note and close it as completed.",
      actions: [
        card({
          id: 6,
          kind: "resolution",
          label: "Ask for the pack",
          title: "Ask the author to use the language pack",
          steps: ["Post the comment below", "Add the label needs changes"],
          settles: 'Answers the merge question with "Ask to use the language pack"',
          option: "changes",
          commentStep: 0,
          text: "Thanks for adding Hungarian. craft-i18n already ships a `hu` pack that craft-proof reads, so the data files don't need to be committed. Could you load the pack instead?",
          writes: "posts a comment on GitHub",
          state: "proposed",
        }),
        card({
          id: 7,
          kind: "resolution",
          label: "Close as completed",
          title: "Close the PR as completed",
          steps: ["Post the comment below", "Close the PR as completed"],
          commentStep: 0,
          settles: "Closes the merge question as handled",
          text: "The Hungarian pack landed in designcraft#1301, so this is covered. Closing; thank you for the work.",
          writes: "closes the PR on GitHub",
          state: "proposed",
        }),
        card({
          id: 8,
          kind: "resolution",
          label: "Hold with a label",
          title: "Hold for a second review",
          steps: ["Add the label needs second review"],
          settles: 'Answers the merge question with "Hold for a second review"',
          option: "hold",
          stale: "new-comments",
          state: "proposed",
        }),
        card({
          id: 9,
          kind: "comment",
          label: "Post comment",
          title: "Ask whether the hyphenation rules differ",
          text: "Do the nonstandard rules in these patterns differ from the ones in the language pack?",
          state: "proposed",
        }),
      ],
      notes: [],
    },
  ];
}

/** In-memory conversations. Only designcraft#1484 starts with one; an operator's message is answered after a few seconds. */
export function createConversationMock(me: User, changed: () => void, settle?: (repo: string, number: number, option: string, note: string | null) => void): Pick<Api, "conversations"> {
  const store = new Map<string, Conversation>([[REF, { repo: "designcraft", number: 1484, exists: true, pending: false, startedBy: "opus", turns: seed(), includes: [{ source: "decision-opinion:designcraft#1484:merge/o0", by: "mosswood", at: at(100), sent: false }] }]]);
  let nextId = 100;
  const open = (repo: string, n: number): Conversation => {
    const k = `${repo}#${n}`;
    let c = store.get(k);
    if (!c) store.set(k, (c = { repo, number: n, exists: false, pending: false, startedBy: null, includes: [], turns: [] }));
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
      async say(repo, n, text, ask) {
        need();
        const c = open(repo, n);
        if (c.pending) throw new Error("Opus has not answered the last message yet");
        if (ask === false) {
          c.turns.push({ id: nextId++, kind: "operator", login: me.login, at: new Date().toISOString(), body: text, actions: [], notes: [] });
          Object.assign(c, { exists: true, startedBy: c.startedBy ?? me.login });
          changed();
          return snap(c);
        }
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
      async include(repo, n, source, on) {
        need();
        const c = open(repo, n);
        const i = c.includes.findIndex((x) => x.source === source);
        if (on && i < 0) c.includes.push({ source, by: me.login, at: new Date().toISOString(), sent: false });
        if (!on && i >= 0) {
          if (c.includes[i]!.sent) throw new Error("Opus already has this post");
          c.includes.splice(i, 1);
        }
        changed();
        return snap(c);
      },
      async editCard(id, text) {
        need();
        const k = find(id);
        Object.assign(k, { text, edited: true });
        changed();
        return snap(k);
      },
      async doCard(id, opts) {
        need();
        const k = find(id);
        if (opts?.note && opts.note.length > 500) throw new Error("the note is longer than 500 characters");
        const c = [...store.values()].find((x) => x.turns.some((t) => t.actions.includes(k)))!;
        k.state = "running";
        changed();
        setTimeout(() => {
          const skipped = opts?.skip ?? [];
          const done = { at: new Date().toISOString(), link: k.kind === "comment" ? "#comment" : "", label: k.kind === "comment" ? `Comment on ${REF}` : k.title };
          Object.assign(k, { state: "done", by: me.login, at: done.at, done });
          const steps = k.steps.filter((_, i) => !skipped.includes(i)).join("; ");
          c.turns.push({ id: nextId++, kind: "system", login: "system", at: done.at, body: `${me.login} ran the card: ${k.title}${steps ? ` (${steps})` : ""}.${opts?.note ? ` Note: ${opts.note}` : ""}`, actions: [], notes: [] });
          if (k.settles !== undefined) settle?.(c.repo, c.number, k.option ?? "handled", opts?.note ?? null);
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
