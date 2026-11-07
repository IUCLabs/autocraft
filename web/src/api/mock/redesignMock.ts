// Mock API for the redesign: Home, the item page, the status list and the security list.
import type { Api } from "../client";
import type { FindingRow, FindingSummary, Home, ItemPhase, ItemStatusRow, SecurityGroup, User } from "../types";
import { decisionPath } from "../../lib/links";
import { FINDING_HISTORY_11, FIX_ROUNDS_11, at, findingStatus, itemPageFor, statusRows } from "./redesignData";

const wait = <T,>(v: T, ms = 60) => new Promise<T>((r) => setTimeout(() => r(structuredClone(v)), ms));
const PHASES: ItemPhase[] = ["Triage", "Waiting for a person", "Review", "Fixing", "Verifying", "In queue", "Merged", "Closed", "Held", "Out of scope"];
const GROUP: Record<string, SecurityGroup> = {
  new: "Needs a person", "awaiting-admin": "Needs a person", ready: "Ready to land", fixing: "Fixing", landing: "Landing",
  landed: "Landed or published", advisory: "Landed or published", published: "Landed or published", dismissed: "Dismissed or backlog", backlog: "Dismissed or backlog",
};
const GROUPS: SecurityGroup[] = ["Needs a person", "Fixing", "Ready to land", "Landing", "Landed or published", "Dismissed or backlog"];
/** Findings whose fix gave up after rounds: number to attempts. */
const ATTEMPTS: Record<number, number> = { 11: 3 };
const NOTE_11 = "the regression test still passes without the fix";

export type RedesignApi = Pick<Api, "home" | "itemPage" | "itemStatusList" | "securityList" | "findingPage">;

export function createRedesignMock(me: User, base: Pick<Api, "decisions" | "security" | "item">): RedesignApi {
  const staff = me.role !== "viewer";
  const rowOf = (f: FindingSummary, note: string | null): FindingRow => {
    const attempts = ATTEMPTS[f.number] ?? 0;
    return { repo: f.repo, number: f.number, title: f.title, severity: f.severity, state: f.state, urgent: f.urgent, area: f.area, attempts, status: findingStatus(f.state, attempts, note), updatedAt: f.updatedAt };
  };
  const findings = async (): Promise<FindingRow[]> => {
    if (!staff) return [];
    const ov = await base.security.overview("designcraft");
    return Promise.all(ov.findings.map(async (f) => rowOf(f, f.number in ATTEMPTS ? NOTE_11 : null)));
  };
  return {
    async home(): Promise<Home> {
      const d = await base.decisions.list({ status: "open", limit: 100 });
      const rec = (x: (typeof d.decisions)[number]) => x.options.find((o) => o.key === x.recommended)?.label ?? null;
      const problems: Home["problems"] = [
        { kind: "stopped", title: "Fix-up stopped by the breaker", detail: "3 pushes in a row broke CI on photocraft; resume after a look.", to: "/needs/stopped" },
        ...(staff ? [{ kind: "gave-up" as const, title: "designcraft finding 11: fix gave up after 3 rounds", detail: "The regression test passes without the fix.", to: "/security/designcraft/11" }] : []),
      ];
      return wait({
        needs: {
          total: d.total + (staff ? 1 : 0), byKind: staff ? { ...d.byKind, security: 1 } : d.byKind,
          oldest: [
            ...(staff ? [{ id: "finding-11", kind: "security" as const, repo: "designcraft", number: 11, title: "Recent-files list opens paths without checking the file type", recommendation: "Fix again with a note", askedAt: at(40), itemKind: null, to: "/security/designcraft/11" }] : []),
            ...d.decisions.slice(0, staff ? 4 : 5).map((x) => ({ id: x.id, kind: x.kind, repo: x.repo, number: x.number, title: x.title, recommendation: rec(x), askedAt: x.askedAt, itemKind: x.shown?.kind ?? null, to: decisionPath(x) })),
          ],
        },
        problems,
        phases: { Triage: 12, "Waiting for a person": d.total + (staff ? 1 : 0), Review: 5, Fixing: 3, Verifying: 2, "In queue": 9, Merged: 14, Closed: 6, Held: 4, "Out of scope": 21 },
        running: "3 jobs running, batch #41 checking",
        progress: { openNow: 412, openAtStart: 960, done24h: 41, byAutoCraftPct: 78, perHour: [1, 2, 1, 0, 0, 1, 3, 2, 4, 3, 2, 5, 4, 3, 2, 1, 3, 4, 5, 6, 4, 3, 2, 3], spendTodayUsd: 38.2 },
        done: [
          { at: at(98), what: "merged", repo: "photocraft", number: 9970, title: "Curves: keep the endpoint handles inside the plot", kind: "pr" },
          { at: at(120), what: "closed", repo: "deckcraft", number: 655, title: "Slide thumbnails are blank after undo", kind: "issue" },
          { at: at(140), what: "review posted", repo: "pdfcraft", number: 2210, title: "Add CMYK output profile selection", kind: "pr" },
          { at: at(180), what: "merged", repo: "craft-libs", number: 412, title: "Bump the egui pin", kind: "pr" },
          { at: at(230), what: "review posted", repo: "gridcraft", number: 977, title: "Range spill: keep neighbouring cells when a formula grows", kind: "pr" },
        ],
      });
    },
    itemPage: async (repo, number) => {
      const p = itemPageFor(repo, number);
      if (p) return wait(me.role === "viewer" ? { ...p, reviews: { latest: p.reviews.latest && { ...p.reviews.latest, fixes: [], risks: [], claims: [] }, earlier: [] }, history: p.history.map((h) => ({ ...h, calls: [] })) } : p);
      const it = await base.item(repo, number);
      return wait({
        repo, number, kind: it.kind, state: it.state, title: it.title, author: it.author, costUsd: 0,
        status: { phase: it.state === "merged" ? "Merged" : it.state === "closed" ? "Closed" : "Triage", waiting: null, next: null, since: it.updatedAt },
        reviews: { latest: null, earlier: [] }, results: [], history: [],
        github: { description: it.body, url: `https://github.com/storytold/${repo}/${it.kind === "pr" ? "pull" : "issues"}/${number}`, events: [{ id: "g1", type: "opened", at: it.createdAt, actor: it.author, body: it.body, autocraft: null }], checks: [], commits: [], files: [] },
      });
    },
    async itemStatusList(f) {
      const fr = await findings();
      const all: ItemStatusRow[] = [
        ...statusRows(),
        ...fr.map((x): ItemStatusRow => ({ repo: x.repo, number: x.number, kind: "finding", state: "open", title: x.title, status: x.status, updatedAt: x.updatedAt, severity: x.severity })),
      ];
      const q = f.q?.trim().toLowerCase();
      const base1 = all.filter((r) => (!f.kind || r.kind === f.kind) && (!f.repo?.length || f.repo.includes(r.repo)) && (!q || `${r.repo}#${r.number} ${r.title}`.toLowerCase().includes(q)));
      const byPhase = Object.fromEntries(PHASES.map((p) => [p, base1.filter((r) => r.status.phase === p).length])) as Record<ItemPhase, number>;
      const rows = base1.filter((r) => !f.phase || r.status.phase === f.phase).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return wait({ rows, byPhase, total: rows.length });
    },
    async securityList() {
      const rows = await findings();
      const rank = { critical: 0, high: 1, medium: 2, low: 3 };
      return wait({ groups: GROUPS.map((group) => ({ group, rows: rows.filter((r) => GROUP[r.state] === group).sort((a, b) => rank[a.severity] - rank[b.severity] || a.number - b.number) })).filter((g) => g.rows.length) });
    },
    async findingPage(repo, number) {
      const finding = await base.security.finding(repo, number);
      const attempts = ATTEMPTS[number] ?? 0;
      const failed = attempts > 0;
      return wait({
        finding, attempts, status: findingStatus(finding.state, attempts, failed ? NOTE_11 : null), rounds: failed ? FIX_ROUNDS_11 : [],
        history: failed ? FINDING_HISTORY_11 : finding.timeline.map((c, i) => ({ id: `t${i}`, at: c.at, step: c.kind === "area" ? "Area scan" : c.kind === "verify" ? "Verification" : c.kind === "model" ? "Threat model" : "Fix", outcome: c.ok ? "done" : "failed", model: "Opus", costUsd: c.costUsd, kind: "model" as const, calls: [], writeId: null })),
        costUsd: failed ? 10.4 : finding.timeline.reduce((s, c) => s + (c.costUsd ?? 0), 0),
      });
    },
  };
}
