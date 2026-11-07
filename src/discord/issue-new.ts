// `/issue new` and the "File a new issue" button: a form, a look for an existing issue, up to three follow-up
// questions, and a draft the person opens on GitHub themselves. The bot never posts to GitHub.
//
// What a person typed lives in memory for the session only (15 minutes) and is never stored or logged. The model calls
// (step `discord-issue`) record their cost under a daily cap of their own; their prompt and reply texts are deleted when
// a call ends, and at startup. Model output is data: questions are picked by id from a fixed list, and the draft is
// length-capped and stripped of mentions and foreign links before it is shown.
import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { askClaude } from "../classify/run.ts";
import { publicRepoNames } from "../public/status.ts";
import { BUTTON_URL_MAX, ISSUE_URL_MAX, cleanDraft, followUp, formDraft, issueUrl, sanitize, seedOf, type PublicRepo } from "./issue-draft.ts";
import { FOLLOW_UPS, ISSUE_ANSWER_CHARS, ISSUE_BODY_CHARS, ISSUE_FORM_BODY_CHARS, ISSUE_TITLE_CHARS, parseDraft, parseQuestions, type FollowUpId, type IssueDraftInput, type IssueQuestionsInput } from "./issue-prompt.ts";
import type { Call, Interactions } from "./interactions.ts";
import type { DiscordKeys } from "./keys.ts";
import { fileRepoUrl, plain } from "./reply.ts";
import { QUESTION_CHARS, type Match, type Search } from "./search.ts";
import { trackedRepos } from "./store.ts";

export const ISSUE_CAP_KEY = "discord_issue_daily_usd";
export const DEFAULT_ISSUE_CAP_USD = 2;
export const ISSUE_STEP = "discord-issue";
const SESSION_MS = 15 * 60_000;
const HOUR = 3_600_000;
const USER_LIMIT = 3, CHANNEL_LIMIT = 10;
const MODEL_WAIT_MS = 20_000;
const MAX_MATCHES = 3;
const MESSAGE_CHARS = 1900;
const MAX_CALLS = 2;
const USED = "That button was already used. Start again with /issue new.";

/** The model step; tests replace it. Null when the call failed or got no answer. */
export type IssueAsk = {
  (db: DatabaseSync, id: "discord.issue-questions", input: IssueQuestionsInput): Promise<string | null>;
  (db: DatabaseSync, id: "discord.issue-draft", input: IssueDraftInput): Promise<string | null>;
};
export const askIssueModel: IssueAsk = (async (db: DatabaseSync, id: "discord.issue-questions", input: IssueQuestionsInput) =>
  (await askClaude(id, "haiku", [input], db, { maxWaitMs: MODEL_WAIT_MS }))?.text ?? null) as IssueAsk;

export function issueCapUsd(db: DatabaseSync): number {
  const v = Number((db.prepare("SELECT value FROM settings WHERE key = ?").get(ISSUE_CAP_KEY) as { value: string } | undefined)?.value);
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_ISSUE_CAP_USD;
}

export function issueSpentTodayUsd(db: DatabaseSync, now: number): number {
  const day = new Date(now).toISOString().slice(0, 10);
  return Number((db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS c FROM agent_runs WHERE step = ? AND started_at >= ?").get(ISSUE_STEP, day) as { c: number }).c);
}

/** The prompt and reply of an issue call hold what the person typed: finished calls lose their texts; `all` (at startup) removes every row. */
export function dropIssueTexts(db: DatabaseSync, all = false): void {
  db.prepare(`DELETE FROM agent_run_texts WHERE run_id IN (SELECT id FROM agent_runs WHERE step = ?${all ? "" : " AND state <> 'running'"})`).run(ISSUE_STEP);
}

type Session = {
  user: string; repo: string; repoUrl: string; expires: number;
  title: string; description: string;
  matches: Match[]; questions: FollowUpId[]; capped: boolean;
  answers: { question: string; answer: string }[];
  draft?: { title: string; body: string };
  /** Where the session is: the buttons of an earlier step stop working once a later one is reached. */
  stage: "form" | "matched" | "asking" | "drafted";
  /** Model calls made; at most MAX_CALLS (the questions and one draft). */
  calls: number;
};

export type IssueNewDeps = { db: DatabaseSync; keys: DiscordKeys; search: Search; log: (line: string) => void; ask?: IssueAsk; now?: () => number };

const field = (custom_id: string, label: string, style: 1 | 2, max: number, opts: { required?: boolean; value?: string; placeholder?: string } = {}) => ({
  type: 1, components: [{ type: 4, custom_id, label: label.slice(0, 45), style, max_length: max, required: opts.required ?? true,
    ...(opts.value ? { value: opts.value.slice(0, max) } : {}), ...(opts.placeholder ? { placeholder: opts.placeholder.slice(0, 100) } : {}) }],
});
const button = (label: string, custom_id: string, style: 1 | 2 = 2) => ({ type: 2, style, label: label.slice(0, 80), custom_id });

export class IssueNew {
  #d: IssueNewDeps;
  #sessions = new Map<string, Session>();
  #hits = new Map<string, number[]>();

  constructor(deps: IssueNewDeps) {
    this.#d = deps;
  }

  #now = (): number => (this.#d.now ?? Date.now)();

  /** Sessions per person and per channel in the last hour (keyed hashes, in memory). A refused try is not counted. */
  allow(userKey: string, channelKey: string): boolean {
    const now = this.#now();
    const live = (k: string): number[] => (this.#hits.get(k) ?? []).filter((t) => now - t < HOUR);
    const u = live(`u:${userKey}`), c = live(`c:${channelKey}`);
    const pass = u.length < USER_LIMIT && c.length < CHANNEL_LIMIT;
    this.#hits.set(`u:${userKey}`, pass ? [...u, now] : u);
    this.#hits.set(`c:${channelKey}`, pass ? [...c, now] : c);
    for (const [k, v] of this.#hits) if (!v.length) this.#hits.delete(k);
    return pass;
  }

  #repos(): PublicRepo[] {
    const names = new Set(publicRepoNames(this.#d.db));
    return trackedRepos(this.#d.db).filter((t) => names.has(t.name)).map((t) => ({ owner: t.owner, name: t.name }));
  }

  #session(call: Call, sid: string | undefined): Session | null {
    const now = this.#now();
    for (const [k, v] of this.#sessions) if (v.expires <= now) this.#sessions.delete(k);
    const s = sid ? this.#sessions.get(sid) : undefined;
    return s && s.user === call.userId ? s : null;
  }

  #overCap(): boolean {
    return issueSpentTodayUsd(this.#d.db, this.#now()) >= issueCapUsd(this.#d.db);
  }

  async #model(id: "discord.issue-questions", input: IssueQuestionsInput): Promise<string | null>;
  async #model(id: "discord.issue-draft", input: IssueDraftInput): Promise<string | null>;
  async #model(id: "discord.issue-questions" | "discord.issue-draft", input: IssueQuestionsInput & IssueDraftInput): Promise<string | null> {
    const { db, log } = this.#d;
    try {
      return await (this.#d.ask ?? askIssueModel)(db, id as "discord.issue-draft", input);
    } catch (e) {
      log(`discord: issue model call failed: ${(e as Error).message.slice(0, 200)}`);
      return null;
    } finally {
      try { dropIssueTexts(db); } catch (e) { log(`discord: removing issue texts failed: ${(e as Error).message}`); }
    }
  }

  /** `/issue new` and the "File a new issue" button: checks the limits and shows the first form. */
  async open(call: Call, repo: string | null, question = ""): Promise<void> {
    const { db, keys } = this.#d;
    const url = repo ? trackedRepos(db).filter((t) => publicRepoNames(db).includes(t.name)).find((t) => t.name === repo) : undefined;
    if (!repo || !url) return void (await call.reply({ content: repo === null ? "Choose a repo: /issue new repo:<name>" : "No public repo by that name." }));
    if (!call.userId || !this.allow(keys.hash("author", call.userId), keys.hash("channel", call.interaction.channel_id ?? "?")))
      return void (await call.reply({ content: "Too many new issues just now. Try again later." }));
    const sid = randomBytes(6).toString("base64url");
    this.#sessions.set(sid, {
      user: call.userId, repo, repoUrl: `https://github.com/${url.owner}/${url.name}`, expires: this.#now() + SESSION_MS,
      title: "", description: "", matches: [], questions: [], capped: false, answers: [], stage: "form", calls: 0,
    });
    await call.showModal({
      custom_id: `inew:form:${sid}`, title: `New issue: ${repo}`.slice(0, 45),
      components: [
        field("title", "Title", 1, 100, { placeholder: "A short summary" }),
        field("description", "Description", 2, ISSUE_FORM_BODY_CHARS, { value: question.replace(/\s+/g, " ").trim(), placeholder: "What happened, or what would you like?" }),
      ],
    });
  }

  /** The form was submitted: the existing issues are searched and, in parallel, the follow-up questions are chosen. */
  async form(call: Call, sid: string): Promise<void> {
    const s = this.#session(call, sid);
    if (!s) return void (await call.edit({ content: "This form has expired. Start again with /issue new." }));
    if (s.stage !== "form") return void (await call.edit({ content: USED }));
    const f = call.fields();
    s.title = (f.title ?? "").replace(/\s+/g, " ").trim().slice(0, 100);
    s.description = (f.description ?? "").trim().slice(0, ISSUE_FORM_BODY_CHARS);
    if (!s.title || !s.description) return void (await call.edit({ content: "Both the title and the description are needed. Start again with /issue new." }));
    s.stage = "matched";
    s.capped = this.#overCap();
    if (!s.capped) s.calls++;
    const asking = s.capped ? Promise.resolve(null) : this.#model("discord.issue-questions", { ref: "discord", repo: s.repo, title: s.title, description: s.description });
    const [found, reply] = await Promise.all([this.#d.search.find(`${s.title}\n${s.description}`.slice(0, QUESTION_CHARS)), asking]);
    s.matches = found.matches.filter((m) => m.repo === s.repo).slice(0, MAX_MATCHES);
    // A failed or unparseable call asks the first three of the list; a model that finds nothing missing asks none.
    s.questions = s.capped ? [] : ((reply === null ? null : parseQuestions(reply)) ?? FOLLOW_UPS.map((q) => q.id)).slice(0, 3);
    if (!s.matches.length) {
      // Nothing to compare with: go on at once, with a button because a modal needs a button press.
      return void (await call.edit({ content: "No existing issue looks like this.", components: [{ type: 1, components: [button("Continue", `inewi:none:${sid}`, 1)] }] }));
    }
    const lines = s.matches.map((m) => `${m.repo}#${m.number} ${plain(m.title).slice(0, 80)}${m.closed ? " (closed)" : ""}${m.reason ? `\n> ${plain(m.reason)}` : ""}`);
    const one = s.matches.length === 1;
    await call.edit({
      content: `Is this already reported?\n${lines.join("\n")}`,
      components: [
        { type: 1, components: s.matches.map((m) => ({ type: 2, style: 5, label: `${m.repo}#${m.number}`.slice(0, 80), url: m.url })) },
        { type: 1, components: [...s.matches.map((m, n) => button(one ? "That's it" : `That's #${m.number}`, `inew:it:${sid}:${n}`)), button("None of these", `inewi:none:${sid}`, 1)] },
      ],
    });
  }

  /** "That's it": the issue link, and the session ends. */
  async match(call: Call, sid: string, n: number): Promise<void> {
    const s = this.#session(call, sid);
    const m = s?.matches[n];
    if (!s || !m || s.stage !== "matched") return void (await call.edit({ content: "This form has expired. Start again with /issue new." }));
    this.#sessions.delete(sid);
    await call.edit({ content: `${m.repo}#${m.number}: ${m.url}` });
  }

  /** "None of these" or "Continue": the follow-up questions in a second form, or the draft at once when there are none. */
  async none(call: Call, sid: string): Promise<void> {
    const s = this.#session(call, sid);
    if (!s) return void (await call.reply({ content: "This form has expired. Start again with /issue new." }));
    if (s.stage !== "matched" && !(s.stage === "asking" && s.questions.length)) return void (await call.reply({ content: USED }));
    if (!s.questions.length) {
      s.stage = "drafted";
      await call.defer();
      return void (await this.#finish(call, s, sid));
    }
    s.stage = "asking";
    await call.showModal({
      custom_id: `inew:ans:${sid}`, title: "A few more details",
      components: s.questions.map((id) => field(id, followUp(id).label, 2, ISSUE_ANSWER_CHARS, { required: false, placeholder: followUp(id).placeholder })),
    });
  }

  async answers(call: Call, sid: string): Promise<void> {
    const s = this.#session(call, sid);
    if (!s) return void (await call.edit({ content: "This form has expired. Start again with /issue new." }));
    if (s.stage !== "asking") return void (await call.edit({ content: USED }));
    s.stage = "drafted";
    const f = call.fields();
    s.answers = s.questions.map((id) => ({ question: followUp(id).label, answer: (f[id] ?? "").trim().slice(0, ISSUE_ANSWER_CHARS) })).filter((a) => a.answer);
    await this.#finish(call, s, sid);
  }

  async #finish(call: Call, s: Session, sid: string): Promise<void> {
    const repos = this.#repos();
    let draft: { title: string; body: string } | null = null;
    if (!s.capped && s.calls < MAX_CALLS && !this.#overCap()) {
      s.calls++;
      const text = await this.#model("discord.issue-draft", { ref: "discord", repo: s.repo, title: s.title, description: s.description, answers: s.answers });
      const raw = text === null ? null : parseDraft(text);
      draft = raw ? cleanDraft(raw, repos) : null;
    }
    s.draft = draft ?? formDraft(s, repos);
    await call.edit(this.#render(s, sid));
  }

  #render(s: Session, sid: string): { content: string; components: unknown[] } {
    const d = s.draft!;
    const { url, trimmed } = issueUrl(s.repoUrl, d.title, d.body, ISSUE_URL_MAX);
    const fence = (t: string): string => `\`\`\`\n${t.replace(/`{3,}/g, "``")}\n\`\`\``;
    const head = `Your draft for ${s.repo}:\n**${plain(d.title)}**\n`;
    const foot = `\n[Open on GitHub](<${url}>)${trimmed ? "\nThe link holds only the start of the text; Edit shows all of it." : ""}`;
    const room = MESSAGE_CHARS - head.length - foot.length - 10;
    const preview = room > 80 ? fence(d.body.length > room ? `${d.body.slice(0, room - 1)}…` : d.body) : "";
    return {
      content: `${head}${preview}${foot}`,
      components: [{ type: 1, components: [
        ...(url.length <= BUTTON_URL_MAX ? [{ type: 2, style: 5, label: "Open on GitHub", url }] : []),
        button("Edit", `inewi:edit:${sid}`),
      ] }],
    };
  }

  /** "Edit": the draft's title and body in a form. */
  async edit(call: Call, sid: string): Promise<void> {
    const s = this.#session(call, sid);
    if (!s?.draft) return void (await call.reply({ content: "This draft has expired. Start again with /issue new." }));
    await call.showModal({
      custom_id: `inew:fix:${sid}`, title: "Edit the draft",
      components: [field("title", "Title", 1, ISSUE_TITLE_CHARS, { value: s.draft.title }), field("body", "Body", 2, 4000, { value: s.draft.body })],
    });
  }

  async fix(call: Call, sid: string): Promise<void> {
    const s = this.#session(call, sid);
    if (!s?.draft) return void (await call.edit({ content: "This draft has expired. Start again with /issue new." }));
    const f = call.fields();
    const d = cleanDraft({ title: f.title ?? "", body: f.body ?? "" }, this.#repos());
    if (d) s.draft = d;
    await call.edit(this.#render(s, sid));
  }
}

export function installIssueNew(ix: Interactions, deps: IssueNewDeps): IssueNew {
  const { db } = deps;
  const flow = new IssueNew(deps);
  const sub = { type: 1, name: "new", description: "Get help writing a new issue", options: [{ type: 3, name: "repo", description: "The repo the issue is for", autocomplete: true }] };
  ix.command("issue new", { name: "issue", type: 1, description: "Find GitHub issues", dm_permission: false, options: [sub] }, async (call) => {
    const named = call.option("repo")?.trim();
    const repo = named || (fileRepoUrl(db, call.interaction.channel_id, [])?.split("/").pop() ?? null);
    await flow.open(call, repo);
  }, { immediate: true });
  ix.autocomplete("issue new", (call) => {
    const typed = (call.focused()?.value ?? "").toLowerCase();
    return publicRepoNames(db).filter((r) => r.toLowerCase().includes(typed)).map((r) => ({ name: r, value: r }));
  });
  // Pressing the "File a new issue" button of a search result: `inewi:open:<repo>[:<seed>]`.
  ix.component("inewi", async (call) => {
    const [, action, a, b] = (call.interaction.data?.custom_id ?? "").split(":");
    if (action === "open") await flow.open(call, a ?? null, seedOf(b));
    else if (action === "none") await flow.none(call, a ?? "");
    else if (action === "edit") await flow.edit(call, a ?? "");
    else await call.reply({ content: "This form has expired. Start again with /issue new." });
  }, { immediate: true });
  ix.component("inew", async (call) => {
    const [, action, sid, n] = (call.interaction.data?.custom_id ?? "").split(":");
    if (action === "form") await flow.form(call, sid ?? "");
    else if (action === "it") await flow.match(call, sid ?? "", Number(n));
    else if (action === "ans") await flow.answers(call, sid ?? "");
    else if (action === "fix") await flow.fix(call, sid ?? "");
    else await call.edit({ content: "This form has expired. Start again with /issue new." });
  });
  return flow;
}
