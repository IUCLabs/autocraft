// The Pipeline page on fake data: a few steps, jobs in every state and recent syncs.
import type { Api } from "../client";
import type { Job, JobDetail, PipelineOverview, PipelineState, PipelineStep, StageLimit, User } from "../types";
import { NOW, REPOS } from "./fixtures";

const wait = <T>(v: T, ms = 60) => new Promise<T>((r) => setTimeout(() => r(structuredClone(v)), ms));
const iso = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();

const STEPS: Omit<PipelineStep, "lastJob">[] = [
  {
    name: "classify-new", title: "Classify new and changed items", stage: 2, requires: "operator", group: "models", unavailable: null,
    description: "Jev labels open items that have no verdict in the current classification run, or whose text changed since; Haiku gives a second opinion where Jev is under 90 % sure.",
    params: [{ name: "limit", label: "At most", kind: "int", min: 1, max: 5000, default: 500, required: false, help: "items per model in this job" }],
  },
  {
    name: "classify-all", title: "Classification pass", stage: 2, requires: "operator", group: "models", unavailable: null,
    description: "Jev labels every open item of the tracked repos into the given run, then Haiku the ones Jev is unsure of. A stopped pass continues where it left off when started again with the same run id; once complete, the run becomes the current one.",
    params: [
      { name: "run", label: "Run id", kind: "run-id", required: true, help: "lowercase letters, digits and dashes" },
      { name: "limit", label: "At most", kind: "int", min: 1, max: 30000, default: 30000, required: false, help: "items per model in this job" },
    ],
  },
  {
    name: "embed", title: "Embed items", stage: 1, requires: "operator", group: "local", unavailable: null,
    description: "Computes local sentence embeddings of new and changed items for similar items and semantic search. Runs on this machine; no model quota.",
    params: [{ name: "scope", label: "Items", kind: "enum", options: ["changed", "all"], default: "changed", required: false }],
  },
  {
    name: "labels-apply", title: "Apply labels on GitHub", stage: 4, requires: "operator", group: "github-write",
    unavailable: "Not available yet: the labels command is not in this build.",
    description: "Puts the settled type label and flags onto the open items of one repo on GitHub. Refused unless the operator has approved labelling for that repo.",
    params: [{ name: "repo", label: "Repo", kind: "repo", options: REPOS, required: true }],
  },
  {
    name: "fixup", title: "Fix up take-fix pull requests", stage: 6, requires: "operator", group: "github-write", unavailable: null,
    description: "For take-fix pull requests we may push to, Sonnet turns the review's fix list into a diff that is checked and applied on top of the reviewed head, pushed to the contributor's branch and noted with one short comment. The new head is reviewed again.",
    params: [{ name: "repo", label: "Repo", kind: "repo", options: REPOS, required: true }, { name: "limit", label: "At most", kind: "int", min: 1, max: 50, default: 5, required: false, help: "pull requests to fix up in this job" }],
  },
  {
    name: "verify", title: "Plan verification of taken pull requests", stage: 6, requires: "operator", group: "verify", unavailable: null,
    description: "Sonnet decides per taken pull request of one repo whether CI is enough, or which crates and tests a build machine should run, or (bug fixes) a regression test that fails before the change. Queues the build tasks; reads GitHub, writes nothing to it.",
    params: [{ name: "repo", label: "Repo", kind: "repo", options: REPOS, required: true }, { name: "limit", label: "At most", kind: "int", min: 1, max: 50, default: 10, required: false, help: "PRs to plan in this job" }],
  },
  {
    name: "verify-collect", title: "Collect verification results", stage: 6, requires: "operator", group: "verify", unavailable: null,
    description: "Reads the finished build tasks of each pending verification and sets passed, failed or error from their exit codes. For a failure, Haiku summarises the log; the failure becomes a hold.",
    params: [],
  },
  {
    name: "act", title: "Comment and close", stage: 6, requires: "operator", group: "github-write", unavailable: null,
    description: "Posts one short comment and closes the items an operator answered Out of scope or Close. Skips an item that already closed or whose PR head moved. Calls no model.",
    params: [{ name: "repo", label: "Repo", kind: "repo", options: REPOS, required: true }, { name: "limit", label: "At most", kind: "int", min: 1, max: 50, default: 20, required: false, help: "items to act on in this job" }],
  },
];

const job = (id: number, step: string, state: Job["state"], startMin: number | null, minutes: number, extra: Partial<Job> = {}): Job => ({
  id, step, params: {}, requestedBy: "ochre-fox", requestedAt: iso((startMin ?? 0) + 1), state,
  startedAt: startMin === null ? null : iso(startMin), endedAt: state === "running" || state === "queued" ? null : iso((startMin ?? 0) - minutes),
  progress: null, summary: null, error: null, cancelRequested: false, usage: null,
  models: step.startsWith("classify") ? ["jev", "haiku"] : step === "opus-review" ? ["opus"] : step === "decide" ? ["sonnet"] : [], accounts: state === "queued" ? [] : step === "opus-review" || step === "decide" || step.startsWith("classify") ? ["Account B"] : [], ...extra,
});

function seed(): Job[] {
  return [
    job(48, "classify-new", "queued", null, 0, { params: { limit: 200 }, requestedBy: "pipeline" }),
    job(47, "classify-new", "running", 9, 0, { params: { limit: 200 }, requestedBy: "pipeline", progress: "Jev: 120 of 164 items", usage: { calls: 120, input: 98_400, output: 6_100, costUsd: null } }),
    job(46, "embed", "done", 25, 2, { params: { scope: "changed" }, requestedBy: "pipeline", summary: "embedded new and changed items" }),
    job(45, "classify-new", "done", 72, 6, { params: { limit: 200 }, requestedBy: "pipeline", summary: "Run org-1102: Jev classified 38 of 38 new or changed items; Haiku gave a second opinion on 9 of 9.", usage: { calls: 39, input: 61_200, output: 4_400, costUsd: 0.07 } }),
    job(44, "classify-all", "cancelled", 300, 41, { params: { run: "org-1102", limit: 30000 }, progress: "Jev: 6,400 of 21,310 items", usage: { calls: 6_400, input: 5_210_000, output: 330_000, costUsd: null } }),
    job(43, "classify-new", "failed", 1500, 1, { params: { limit: 500 }, error: "There is no classification run yet; start a classification pass first." }),
  ];
}

const LOG = `2026-11-02T10:31:02.114Z job 47: classify-new {"limit":200}, requested by pipeline
run org-1102: 21310 open items, 164 due for Jev, taking 164
Jev: 40 of 164 items
Jev: 80 of 164 items
jev: no valid answer for photocraft#2214
Jev: 120 of 164 items`;

export function createPipelineMock(me: User, changed: () => void): Pick<Api, "pipeline"> {
  const jobs = seed();
  const steps = structuredClone(STEPS);
  let next = 49;
  const flag = { enabled: true, changedBy: "ochre-fox" as string | null, changedAt: iso(300) as string | null };
  const limits: StageLimit[] = [
    ["classify-new", "Classify new and changed items", 2000, 412], ["embed", "Embed items", null, 0], ["decide", "Ask decisions", 100, 100],
    ["checks", "Refresh CI and merge state", null, 38], ["opus-review", "Review pull requests", 40, 14], ["labels-apply", "Apply labels on GitHub", null, 0], ["merge", "Merge queued pull requests", 10, 2],
    ["verify", "Plan verification of taken pull requests", 40, 12], ["fixup", "Fix up take-fix pull requests", 10, 3], ["act", "Comment and close", 20, 20],
  ].map(([step, title, perDay, usedToday]) => ({
    step: step as string, title: title as string, perDay: perDay as number | null, usedToday: usedToday as number,
    pausedReason: perDay !== null && (usedToday as number) >= (perDay as number) ? `daily limit of ${perDay} items reached` : null,
  }));
  const pilot: string[] = [];
  const state = (): PipelineState => ({ ...flag, heartbeat: iso(0), limits, pilot: [...pilot] });
  const requireOperator = () => {
    if (me.role !== "operator") throw new Error("only operators run or cancel pipeline steps and change the pipeline switch and limits");
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
      state: () => wait(state()),
      async setEnabled(enabled) {
        requireOperator();
        Object.assign(flag, { enabled, changedBy: me.login, changedAt: new Date(NOW).toISOString() });
        changed();
        return wait(state(), 30);
      },
      async setPilot(items) {
        requireOperator();
        const bad = items.find((x) => !/^[A-Za-z0-9._-]+#[1-9][0-9]*$/.test(x));
        if (bad) throw new Error(`not a repo#number reference: ${bad}`);
        pilot.splice(0, pilot.length, ...items);
        changed();
        return wait(state(), 30);
      },
      async resetLimit(step) {
        requireOperator();
        const hit = step === "all" ? limits : limits.filter((x) => x.step === step);
        if (!hit.length) throw new Error("no such stage");
        for (const l of hit) {
          l.usedToday = 0;
          l.pausedReason = l.perDay === 0 ? "paused: the daily limit is 0" : null;
        }
        changed();
        return wait(state(), 30);
      },
      async setLimit(step, input) {
        requireOperator();
        const l = limits.find((x) => x.step === step);
        if (!l) throw new Error("no such stage");
        if (input.perDay !== null && (!Number.isInteger(input.perDay) || input.perDay < 0)) throw new Error("perDay must be null or a whole number from 0 to 100000");
        l.perDay = input.perDay;
        l.pausedReason = l.perDay === 0 ? "paused: the daily limit is 0" : l.perDay !== null && l.usedToday >= l.perDay ? `daily limit of ${l.perDay} items reached` : null;
        changed();
        return wait(l, 30);
      },
    },
  };
}
