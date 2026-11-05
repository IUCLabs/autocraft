import type { Api } from "../client";
import type { Decision, DecisionComment, DecisionFilter, User } from "../types";
import { canAct } from "../../registry/permissions";
import { setClock } from "../../lib/format";
import { createAdminMock } from "./adminMock";
import { createMcpMock } from "./mcpMock";
import { createAgentsMock } from "./agentsMock";
import { createTraceMock } from "./traceMock";
import { createNowMock } from "./nowMock";
import { createActivityMock } from "./activityMock";
import { createAreasMock } from "./areasMock";
import { createConversationMock } from "./conversationMock";
import { createSecurityMock } from "./securityMock";
import { createBuildMock } from "./buildMock";
import { createPipelineMock } from "./pipelineMock";
import { promptsReport } from "../../../../src/prompts/index.ts";
import { semanticHits, similarFor } from "./similarFixtures";
import { classifierReport, costReport, disagreementList } from "./insightFixtures";
import { pickDecision, shortRepo } from "../../lib/links";
import { itemList, settledFor } from "./itemsFixtures";
import { postmergeFor, premergeFor, prWorkFor } from "./verifyFixtures";
import { nextPageFixture } from "./nextMock";
import { queueBatchList, queueList } from "./queueFixtures";
import { batchDetailMock } from "./batchMock";
import { createQueueMock } from "./queueMock";
import { needsPage } from "./needsFixtures";
import { workList } from "./workFixtures";
import { flowFixture } from "./flowFixtures";
import { mainCi } from "./mainCiMock";
import { DECISIONS, MOCK_USERS, MOCK_REPO_OWNERS, NOW, REPOS, SEARCH_POOL, THREADS, itemFor, permFor, progress, type MockRole } from "./fixtures";

const wait = <T>(v: T, ms = 60) => new Promise<T>((r) => setTimeout(() => r(structuredClone(v)), ms));
const nowIso = () => new Date(NOW).toISOString();
const ROLE_KEY = "autocraft:mock-as";

/** Mock role: `?as=operator|maintainer|viewer`, else the last one picked, else operator. */
export function mockRole(): MockRole {
  const q = new URLSearchParams(location.search).get("as");
  let v: string | null = q;
  if (!v) {
    try {
      v = localStorage.getItem(ROLE_KEY);
    } catch {
      v = null;
    }
  }
  return v && v in MOCK_USERS ? (v as MockRole) : "operator";
}

export function setMockRole(r: MockRole) {
  try {
    localStorage.setItem(ROLE_KEY, r);
  } catch {
    /* storage blocked */
  }
  const u = new URL(location.href);
  u.searchParams.delete("as");
  location.replace(u.toString());
}

/** In-memory API over the fixture. Writes change the in-memory copy until reload. */
export function createMockApi(): Api {
  setClock(() => NOW);
  const me: User = MOCK_USERS[mockRole()];
  const decisions = structuredClone(DECISIONS);
  const threads: Record<string, DecisionComment[]> = structuredClone(THREADS);
  const listeners = new Set<() => void>();
  const changed = () => listeners.forEach((fn) => fn());
  const find = (id: string) => {
    const d = decisions.find((x) => x.id === id);
    if (!d) throw new Error(`no decision ${id}`);
    return d;
  };
  const reposOf = (d: Decision) => (d.items.length ? d.items.map((i) => i.repo) : [d.repo]);
  // The server checks the same rules; the client only hides what would be refused.
  const requireOperator = (d: Decision) => {
    if (!canAct(me, reposOf(d))) throw new Error("not allowed");
  };

  const matches = (d: Decision, f: DecisionFilter) => {
    const status = f.status ?? "open";
    if (status !== "answered" && d.answer) return false;
    if (status === "open" && d.snoozed) return false;
    if (status === "snoozed" && !d.snoozed) return false;
    if (status === "answered" && (!d.answer || d.answer === "backlog")) return false;
    if (status === "backlog" && d.answer !== "backlog") return false;
    if (status === "snoozed" && !d.snoozed) return false;
    if (status === "open" && d.snoozed) return false;
    if (status === "opinions" && !d.opinions.length && !d.commentCount) return false;
    if (f.repo?.length && !f.repo.includes(d.repo)) return false;
    if (f.number !== undefined && !(d.number === f.number || d.items.some((i) => i.repo === d.repo && i.number === f.number))) return false;
    if (f.kind?.length && !f.kind.includes(d.kind)) return false;
    if (f.minAge && NOW - Date.parse(d.askedAt) < f.minAge * 86400_000) return false;
    if (f.mine && !me.writeRepos.includes(d.repo)) return false;
    return true;
  };

  const settle = (d: Decision, answer: string, note: string | null, adoptedOpinion: Decision["adoptedOpinion"], exceptions: Decision["exceptions"] = []) =>
    Object.assign(d, { answer, answerNote: note, exceptions, answeredBy: me.login, answeredAt: nowIso(), adoptedOpinion, claim: null, undoable: true });

  return {
    me: () => wait(me, 10),
    repos: () => wait(REPOS, 10),
    repoOwners: () => wait(MOCK_REPO_OWNERS, 10),
    decisions: {
      list(filter) {
        const all = decisions.filter((d) => matches(d, filter));
        const sorted =
          !["answered", "backlog"].includes(filter.status ?? "open")
            ? all.sort((a, b) => a.askedAt.localeCompare(b.askedAt))
            : all.sort((a, b) => (b.answeredAt ?? "").localeCompare(a.answeredAt ?? ""));
        const byKind: Partial<Record<Decision["kind"], number>> = {};
        for (const d of sorted) byKind[d.kind] = (byKind[d.kind] ?? 0) + 1;
        const from = filter.after ? sorted.findIndex((d) => d.id === filter.after) + 1 : (filter.offset ?? 0);
        const page = sorted.slice(from, from + (filter.limit ?? 100));
        const more = page.length > 0 && from + page.length < sorted.length;
        return wait({ decisions: page, total: sorted.length, byKind, oldestAskedAt: sorted[0]?.askedAt ?? null, next: more ? page[page.length - 1]!.id : null });
      },
      get: (id) => wait(find(id)),
      forItem: (repo, number, kind) => wait(pickDecision(decisions.filter((d) => d.repo === shortRepo(repo) && d.number === number && (!kind || d.kind === kind))) ?? null),
      async answer(id, input) {
        const d = find(id);
        requireOperator(d);
        settle(d, input.answer, input.note ?? null, null, input.exceptions ?? []);
        changed();
        return wait(d, 30);
      },
      async undo(id) {
        const d = find(id);
        requireOperator(d);
        if (!d.undoable) throw new Error("already applied");
        Object.assign(d, { answer: null, answerNote: null, answeredBy: null, answeredAt: null, adoptedOpinion: null, exceptions: [], undoable: false });
        changed();
        return wait(d, 30);
      },
      async reopen(id) {
        const d = find(id);
        requireOperator(d);
        if (d.answer !== "backlog") throw new Error("that decision is not in the Backlog");
        Object.assign(d, { answer: null, answerNote: null, answeredBy: null, answeredAt: null, adoptedOpinion: null, exceptions: [] });
        changed();
        return wait(d, 30);
      },
      async feedback(id, input) {
        const d = find(id);
        const text = input.text?.trim() || null;
        if (!input.option && !text) throw new Error("give an option, text, or both");
        if (input.option) {
          if (d.answer) throw new Error("already answered");
          d.opinions = d.opinions.filter((o) => o.login !== me.login);
          d.opinions.unshift({ id: `${id}/o${Date.now()}`, login: me.login, option: input.option, note: text, at: nowIso(), permission: permFor(me.login, d.repo) });
        } else {
          (threads[id] ??= []).push({ id: `${id}/c${Date.now()}`, login: me.login, at: nowIso(), body: text! });
          d.commentCount++;
        }
        changed();
        return wait(d, 30);
      },
      async retract(id) {
        const d = find(id);
        d.opinions = d.opinions.filter((o) => o.login !== me.login);
        changed();
        return wait(d, 30);
      },
      async adopt(id, oid) {
        const d = find(id);
        requireOperator(d);
        const o = d.opinions.find((x) => x.id === oid);
        if (!o?.option) throw new Error("no option to adopt");
        settle(d, o.option, null, o);
        changed();
        return wait(d, 30);
      },
      async snooze(id, on) {
        const d = find(id);
        requireOperator(d);
        d.snoozed = on ? { by: me.login, at: nowIso() } : null;
        changed();
        return wait(d, 30);
      },
      claim: () => wait(undefined, 10),
      thread: (id) => wait(threads[id] ?? []),
    },
    release: () => wait(undefined, 60),
    item: (repo, number) => {
      const it = itemFor(repo, number);
      const postmerge = postmergeFor(number, it.kind, mockRole() !== "viewer");
      const merged = postmerge ? { state: "merged" as const, mergedAt: postmerge.at, mergedBy: "pipeline" } : {};
      return wait({ ...it, ...merged, settled: settledFor(number), ...prWorkFor(number, it.kind), premerge: premergeFor(number, it.kind), postmerge });
    },
    items: (f) => wait(itemList(f), 70),
    search(q) {
      const s = q.trim().toLowerCase();
      if (!s) return Promise.resolve([]);
      const ref = s.match(/^([a-z-]+)?#(\d+)$/);
      const hits = SEARCH_POOL.filter((h) =>
        ref
          ? (!ref[1] || h.repo.startsWith(ref[1])) && String(h.number).startsWith(ref[2])
          : h.title.toLowerCase().includes(s) || h.author.toLowerCase().includes(s) || `${h.repo}#${h.number}`.includes(s),
      );
      return wait(hits.slice(0, 8), 40);
    },
    progress: () => wait(progress(decisions.filter((d) => !d.answer).length)),
    mainCi: () => wait(mainCi()),
    ...createConversationMock(me, changed, (repo, number, option, note) => {
      const d = decisions.find((x) => !x.answer && x.repo === shortRepo(repo) && x.number === number);
      if (d) settle(d, option, note, null);
    }),
    ...createAreasMock(me, changed),
    ...createAdminMock(me, changed),
    ...createMcpMock(me, changed),
    classifiers: {
      report: (sel) => wait(classifierReport(sel), 80),
      disagreements: (f) => wait(disagreementList(f), 60),
    },
    cost: (run) => wait(costReport(run), 80),
    ...createPipelineMock(me, changed),
    ...createAgentsMock(me, changed),
    ...createTraceMock(),
    ...createNowMock(changed),
    ...createActivityMock(),
    ...createBuildMock(me, changed),
    ...createSecurityMock(me, changed),
    ...createQueueMock(me, changed),
    prompts: () => wait(promptsReport(null), 60),
    next: () => wait(nextPageFixture(), 60),
    queue: (f) => wait(queueList(f), 60),
    needs: (f) => wait(needsPage(f), 60),
    queueBatches: (f) => wait(queueBatchList(f), 60),
    batch: (id) => wait(batchDetailMock(id), 60),
    flow: (repo) => wait(flowFixture(repo), 60),
    signOut: () => wait(undefined),
    subscribe(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    similar: (repo, number, limit) => wait(similarFor(repo, number, limit), 120),
    semanticSearch: (q) => wait(semanticHits(q), 90),
    work: (f) => wait(workList(f), 60),
  };
}
