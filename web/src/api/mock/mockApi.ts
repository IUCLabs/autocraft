import type { Api } from "../client";
import type { Decision, DecisionComment, DecisionFilter, User } from "../types";
import { decisionAccess } from "../../registry/permissions";
import { DECISIONS, MOCK_USERS, NOW, REPOS, SEARCH_POOL, THREADS, itemFor, progress, type MockRole } from "./fixtures";

const wait = <T>(v: T, ms = 60) => new Promise<T>((r) => setTimeout(() => r(structuredClone(v)), ms));
const nowIso = () => new Date(NOW).toISOString();
const ROLE_KEY = "craft-triage:mock-as";

/** Mock role: `?as=operator|maintainer|maintainer-off|viewer`, else the last one picked, else operator. */
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
  const require = (d: Decision, mode: "answer" | "propose") => {
    const a = decisionAccess(me, reposOf(d));
    if (a.mode !== mode) throw new Error(a.mode === "read" ? a.reason : `${me.role} can't ${mode}`);
  };
  const pending = (d: Decision) => d.proposals.some((p) => p.status === "pending");

  const matches = (d: Decision, f: DecisionFilter) => {
    const status = f.status ?? "open";
    if (status !== "answered" && d.answer) return false;
    if (status === "answered" && !d.answer) return false;
    if (status === "proposals" && !pending(d)) return false;
    if (f.repo?.length && !f.repo.includes(d.repo)) return false;
    if (f.kind?.length && !f.kind.includes(d.kind)) return false;
    if (f.minAge && NOW - Date.parse(d.askedAt) < f.minAge * 86400_000) return false;
    if (f.mine && !me.writeRepos.includes(d.repo)) return false;
    return true;
  };

  const settle = (d: Decision, answer: string, note: string | null, proposedBy: string | null, exceptions: Decision["exceptions"] = []) =>
    Object.assign(d, { answer, answerNote: note, exceptions, answeredBy: me.login, answeredAt: nowIso(), proposedBy, claim: null });

  return {
    me: () => wait(me, 10),
    repos: () => wait(REPOS, 10),
    decisions: {
      list(filter) {
        const all = decisions.filter((d) => matches(d, filter));
        const sorted =
          (filter.status ?? "open") !== "answered"
            ? all.sort((a, b) => a.askedAt.localeCompare(b.askedAt))
            : all.sort((a, b) => (b.answeredAt ?? "").localeCompare(a.answeredAt ?? ""));
        const byKind: Partial<Record<Decision["kind"], number>> = {};
        for (const d of sorted) byKind[d.kind] = (byKind[d.kind] ?? 0) + 1;
        return wait({ decisions: sorted, total: sorted.length, byKind, oldestAskedAt: sorted[0]?.askedAt ?? null });
      },
      get: (id) => wait(find(id)),
      async answer(id, input) {
        const d = find(id);
        require(d, "answer");
        settle(d, input.answer, input.note ?? null, null, input.exceptions ?? []);
        d.proposals.forEach((p) => p.status === "pending" && Object.assign(p, { status: "rejected", decidedBy: me.login, decidedAt: nowIso() }));
        changed();
        return wait(d, 30);
      },
      async undo(id) {
        const d = find(id);
        require(d, "answer");
        if (d.appliedAt) throw new Error("already applied");
        Object.assign(d, { answer: null, answerNote: null, answeredBy: null, answeredAt: null, proposedBy: null, exceptions: [] });
        d.proposals.forEach((p) => p.decidedAt === nowIso() && Object.assign(p, { status: "pending", decidedBy: null, decidedAt: null }));
        changed();
        return wait(d, 30);
      },
      async propose(id, input) {
        const d = find(id);
        require(d, "propose");
        d.proposals.forEach((p) => p.login === me.login && p.status === "pending" && (p.status = "withdrawn"));
        d.proposals.push({ id: `${id}/p${d.proposals.length}`, login: me.login, option: input.answer, note: input.note ?? null, at: nowIso(), status: "pending", decidedBy: null, decidedAt: null });
        changed();
        return wait(d, 30);
      },
      async approve(id, pid) {
        const d = find(id);
        require(d, "answer");
        const p = d.proposals.find((x) => x.id === pid);
        if (!p) throw new Error("no such proposal");
        Object.assign(p, { status: "approved", decidedBy: me.login, decidedAt: nowIso() });
        settle(d, p.option, p.note, p.login);
        changed();
        return wait(d, 30);
      },
      async reject(id, pid) {
        const d = find(id);
        require(d, "answer");
        Object.assign(d.proposals.find((x) => x.id === pid)!, { status: "rejected", decidedBy: me.login, decidedAt: nowIso() });
        changed();
        return wait(d, 30);
      },
      async withdraw(id, pid) {
        const d = find(id);
        const p = d.proposals.find((x) => x.id === pid && x.login === me.login);
        if (!p) throw new Error("not your proposal");
        p.status = "withdrawn";
        changed();
        return wait(d, 30);
      },
      claim: () => wait(undefined, 10),
      thread: (id) => wait(threads[id] ?? []),
      async comment(id, body) {
        const d = find(id);
        if (decisionAccess(me, reposOf(d)).mode === "read") throw new Error("read-only");
        const c = { id: `${id}/c${Date.now()}`, login: me.login, at: nowIso(), body };
        (threads[id] ??= []).push(c);
        d.commentCount++;
        changed();
        return wait(c, 30);
      },
    },
    item: (repo, number) => wait(itemFor(repo, number)),
    search(q) {
      const s = q.trim().toLowerCase();
      if (!s) return wait([]);
      const ref = s.match(/^([a-z-]+)?#(\d+)$/);
      const hits = SEARCH_POOL.filter((h) =>
        ref
          ? (!ref[1] || h.repo.startsWith(ref[1])) && String(h.number).startsWith(ref[2])
          : h.title.toLowerCase().includes(s) || h.author.toLowerCase().includes(s) || `${h.repo}#${h.number}`.includes(s),
      );
      return wait(hits.slice(0, 8), 40);
    },
    progress: () => wait(progress(decisions.filter((d) => !d.answer).length)),
    signOut: () => wait(undefined),
    subscribe(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
  };
}
