// The Pipeline page on fake data: a few steps, jobs in every state and recent syncs.
import type { Api } from "../client";
import type { Job, JobDetail, PipelineOverview, PipelineStep, Schedule, User } from "../types";
import { NOW, REPOS } from "./fixtures";

const wait = <T>(v: T, ms = 60) => new Promise<T>((r) => setTimeout(() => r(structuredClone(v)), ms));
const iso = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();
const OFF: Schedule = { enabled: false, trigger: "interval", intervalMinutes: 60, params: {}, updatedBy: null, updatedAt: null, lastEnqueuedAt: null };

const STEPS: Omit<PipelineStep, "lastJob">[] = [
  {
    name: "classify-new", title: "Classify new and changed items", stage: 2, requires: "operator", group: "models", unavailable: null,
    description: "Jev labels open items that have no verdict in the current classification run, or whose text changed since; Haiku gives a second opinion where Jev is under 90 % sure.",
    params: [{ name: "limit", label: "At most", kind: "int", min: 1, max: 5000, default: 500, required: false, help: "items per model in this job" }],
    schedule: { enabled: true, trigger: "after-sync", intervalMinutes: null, params: { limit: 200 }, updatedBy: "ochre-fox", updatedAt: iso(3000), lastEnqueuedAt: iso(12) },
  },
  {
    name: "classify-all", title: "Classification pass", stage: 2, requires: "operator", group: "models", unavailable: null,
    description: "Jev labels every open item of the tracked repos into the given run, then Haiku the ones Jev is unsure of. A stopped pass continues where it left off when started again with the same run id; once complete, the run becomes the current one.",
    params: [
      { name: "run", label: "Run id", kind: "run-id", required: true, help: "lowercase letters, digits and dashes" },
      { name: "limit", label: "At most", kind: "int", min: 1, max: 30000, default: 30000, required: false, help: "items per model in this job" },
    ],
    schedule: OFF,
  },
  {
    name: "embed", title: "Embed items", stage: 1, requires: "operator", group: "local", unavailable: null,
    description: "Computes local sentence embeddings of new and changed items for similar items and semantic search. Runs on this machine; no model quota.",
    params: [{ name: "scope", label: "Items", kind: "enum", options: ["changed", "all"], default: "changed", required: false }],
    schedule: { ...OFF, enabled: true, intervalMinutes: 30, params: { scope: "changed" }, updatedBy: "ochre-fox", updatedAt: iso(4000), lastEnqueuedAt: iso(25) },
  },
  {
    name: "labels-apply", title: "Apply labels on GitHub", stage: 4, requires: "operator", group: "github-write",
    unavailable: "Not available yet: the labels command is not in this build.",
    description: "Puts the settled type label and flags onto the open items of one repo on GitHub. Refused unless the operator has approved labelling for that repo.",
    params: [{ name: "repo", label: "Repo", kind: "repo", options: REPOS, required: true }],
    schedule: OFF,
  },
];

const job = (id: number, step: string, state: Job["state"], startMin: number | null, minutes: number, extra: Partial<Job> = {}): Job => ({
  id, step, params: {}, requestedBy: "ochre-fox", requestedAt: iso((startMin ?? 0) + 1), state,
  startedAt: startMin === null ? null : iso(startMin), endedAt: state === "running" || state === "queued" ? null : iso((startMin ?? 0) - minutes),
  progress: null, summary: null, error: null, cancelRequested: false, usage: null, ...extra,
});

function seed(): Job[] {
  return [
    job(48, "classify-new", "queued", null, 0, { params: { limit: 200 }, requestedBy: "schedule" }),
    job(47, "classify-new", "running", 9, 0, { params: { limit: 200 }, requestedBy: "schedule", progress: "Jev: 120 of 164 items", usage: { calls: 120, input: 98_400, output: 6_100, costUsd: null } }),
    job(46, "embed", "done", 25, 2, { params: { scope: "changed" }, requestedBy: "schedule", summary: "embedded new and changed items" }),
    job(45, "classify-new", "done", 72, 6, { params: { limit: 200 }, requestedBy: "schedule", summary: "Run org-1102: Jev classified 38 of 38 new or changed items; Haiku gave a second opinion on 9 of 9.", usage: { calls: 39, input: 61_200, output: 4_400, costUsd: 0.07 } }),
    job(44, "classify-all", "cancelled", 300, 41, { params: { run: "org-1102", limit: 30000 }, progress: "Jev: 6,400 of 21,310 items", usage: { calls: 6_400, input: 5_210_000, output: 330_000, costUsd: null } }),
    job(43, "classify-new", "failed", 1500, 1, { params: { limit: 500 }, error: "There is no classification run yet; start a classification pass first." }),
  ];
}

const LOG = `2026-11-02T10:31:02.114Z job 47: classify-new {"limit":200}, requested by schedule
run org-1102: 21310 open items, 164 due for Jev, taking 164
Jev: 40 of 164 items
Jev: 80 of 164 items
jev: no valid answer for photocraft#2214
Jev: 120 of 164 items`;

export function createPipelineMock(me: User, changed: () => void): Pick<Api, "pipeline"> {
  const jobs = seed();
  const steps = structuredClone(STEPS);
  let next = 49;
  const requireOperator = () => {
    if (me.role !== "operator") throw new Error("only operators run, cancel or schedule pipeline steps");
  };
  const overview = (): PipelineOverview => {
    const withLast = steps.map((s) => ({ ...s, lastJob: jobs.find((j) => j.step === s.name) ?? null }));
    const active = (names: string[]) => jobs.find((j) => names.includes(j.step) && (j.state === "running" || j.state === "queued"));
    const stage = (n: number, name: string, automatic = false) => {
      const names = steps.filter((s) => s.stage === n).map((s) => s.name);
      const mode = automatic ? "automatic" : names.length ? "steps" : "planned";
      const a = active(names);
      const last = jobs.find((j) => names.includes(j.step) && (j.state === "done" || j.state === "failed"));
      const state = mode === "planned" ? "planned" : a ? (a.state === "running" ? "running" : "queued") : automatic || last?.state === "done" ? "ok" : last ? "failed" : "idle";
      return { n, name, mode, steps: names, state } as PipelineOverview["stages"][number];
    };
    return {
      stages: [stage(1, "Mirror", true), stage(2, "Classify"), stage(3, "Decide"), stage(4, "Label"), stage(5, "Review"), stage(6, "Integrate"), stage(7, "Fix issues")],
      steps: withLast,
      runner: { lastSeen: iso(0), alive: true },
      sync: {
        lastFinishedAt: iso(1),
        runs: Array.from({ length: 6 }, (_, i) => ({ startedAt: iso(i + 1.2), endedAt: iso(i + 1), mode: i === 4 ? "per-repo" : "search", items: [3, 0, 7, 1, 412, 2][i]!, error: null })),
      },
      counts: { queued: jobs.filter((j) => j.state === "queued").length, running: jobs.filter((j) => j.state === "running").length },
    };
  };
  const find = (id: number) => {
    const j = jobs.find((x) => x.id === id);
    if (!j) throw new Error(`no job ${id}`);
    return j;
  };
  return {
    pipeline: {
      overview: () => wait(overview()),
      jobs: (f) => {
        const list = jobs.filter((j) => (!f.step || j.step === f.step) && (!f.state || j.state === f.state));
        return wait({ jobs: list.slice(f.offset ?? 0, (f.offset ?? 0) + (f.limit ?? 50)), total: list.length });
      },
      job: (id) => {
        const j = find(id);
        const d: JobDetail = { ...j, log: j.id === 47 ? LOG : j.startedAt ? `${j.startedAt} job ${j.id}: ${j.step}\n${j.summary ?? j.error ?? ""}` : "", logTruncated: false };
        return wait(d);
      },
      async run(step, params) {
        requireOperator();
        const s = steps.find((x) => x.name === step);
        if (!s) throw new Error("no such step");
        if (s.unavailable) throw new Error(s.unavailable);
        const j = job(next++, step, "queued", null, 0, { params, requestedBy: me.login, requestedAt: new Date(NOW).toISOString() });
        jobs.unshift(j);
        changed();
        return wait(j, 30);
      },
      async cancel(id) {
        requireOperator();
        const j = find(id);
        if (j.state === "queued") Object.assign(j, { state: "cancelled", endedAt: new Date(NOW).toISOString(), cancelRequested: true });
        else if (j.state === "running") j.cancelRequested = true;
        else throw new Error(`job ${id} has already ended`);
        changed();
        return wait(j, 30);
      },
      async schedule(step, input) {
        requireOperator();
        const s = steps.find((x) => x.name === step);
        if (!s) throw new Error("no such step");
        s.schedule = { ...s.schedule, ...input, updatedBy: me.login, updatedAt: new Date(NOW).toISOString() };
        changed();
        return wait(s.schedule, 30);
      },
    },
  };
}
