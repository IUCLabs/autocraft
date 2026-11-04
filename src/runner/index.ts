// autocraft runner serve | exec | enqueue | jobs | cancel | steps; autocraft pipeline on | off | status | limit
import { resumeStage, TripError } from "../push-outcomes.ts";
import { startWorkerServer } from "../build/worker-api.ts";
import { acquireLock } from "../mirror.ts";
import { connect } from "../db.ts";
import { audit } from "../dash/audit.ts";
import { scopeToTracked } from "../repos.ts";
import { execJob } from "./exec.ts";
import { LimitError, pipelineState, resetLimitCount, setEnabled, setLimit } from "./autopilot.ts";
import { PilotError, pilotItems, setPilot } from "../pilot.ts";
import { enqueue, JobError, listJobs, requestCancel } from "./jobs.ts";
import { DEFAULT_MAX_JOBS, Runner, runnerLockPath } from "./runner.ts";
import { loadSteps } from "./steps.ts";
import { envVar } from "../env.ts";

const USAGE = `usage: autocraft runner serve
       autocraft runner steps
       autocraft runner enqueue <step> [--<param> <value> ...]
       autocraft runner jobs [--state queued|running|done|failed|cancelled] [--limit N]
       autocraft runner cancel <job id>`;

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

async function serve(): Promise<void> {
  const lock = runnerLockPath();
  const release = acquireLock(lock);
  if (!release) die("another runner is running on this database");
  const db = connect();
  scopeToTracked(db);
  const runner = new Runner({ db, lockFile: lock, maxJobs: Number(envVar("RUNNER_JOBS")) || DEFAULT_MAX_JOBS });
  const ac = new AbortController();
  process.once("SIGTERM", () => ac.abort());
  process.once("SIGINT", () => ac.abort());
  console.log(`runner: started on ${(await loadSteps()).size} steps`);
  // A failure to listen (port in use) must not stop the pipeline; workers just cannot connect.
  const workers = await startWorkerServer({ db, log: (l) => console.log(l) }).then(
    (w) => (console.log(`runner: worker API on ${w.url}`), w),
    (e: Error) => (console.error(`runner: worker API not started: ${e.message}`), null),
  );
  try {
    await runner.serve(ac.signal, Number(envVar("RUNNER_POLL_MS")) || 2000);
  } finally {
    await workers?.close();
    release();
    db.close();
  }
  console.log("runner: stopped");
}

async function exec(args: string[]): Promise<void> {
  const id = Number(args[0]);
  if (!Number.isInteger(id)) die(USAGE);
  process.exit(await execJob(id));
}

async function steps(): Promise<void> {
  for (const s of (await loadSteps()).values()) {
    const why = s.available?.();
    console.log(`${s.name.padEnd(16)} ${s.title}${why ? ` (${why})` : ""}`);
    for (const p of s.params) console.log(`  --${p.name.padEnd(12)} ${p.kind}${p.kind === "enum" ? ` ${p.options.join("|")}` : p.kind === "int" ? ` ${p.min}..${p.max}` : ""}${p.required ? " (required)" : ""}`);
  }
}

// Recorded as `cli`: only someone with a shell on the host can run this.
async function enqueueCmd(args: string[]): Promise<void> {
  const [name, ...rest] = args;
  if (!name) die(USAGE);
  const step = (await loadSteps()).get(name) ?? die(`no step ${name}`);
  const params: Record<string, string | number> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const k = rest[i]?.replace(/^--/, "") ?? "";
    const p = step.params.find((x) => x.name === k);
    if (!p || rest[i + 1] === undefined) die(`unknown or incomplete option ${rest[i]}`);
    params[k] = p.kind === "int" ? Number(rest[i + 1]) : rest[i + 1]!;
  }
  const db = connect();
  scopeToTracked(db);
  try {
    const job = await enqueue(db, name, params, "cli");
    console.log(`job ${job.id} queued: ${job.step} ${JSON.stringify(job.params)}`);
  } catch (e) {
    if (e instanceof JobError) die(e.message);
    throw e;
  }
}

function jobs(args: string[]): void {
  const state = args[args.indexOf("--state") + 1];
  const limit = Number(args[args.indexOf("--limit") + 1]) || 20;
  const list = listJobs(connect(), { state: args.includes("--state") ? (state as never) : undefined, limit });
  for (const j of list.jobs) {
    console.log(`${String(j.id).padStart(5)} ${j.state.padEnd(9)} ${j.step.padEnd(16)} ${j.requestedAt.slice(0, 16)} ${j.requestedBy.padEnd(12)} ${j.summary ?? j.error ?? j.progress ?? ""}`);
  }
}

function cancel(args: string[]): void {
  const id = Number(args[0]);
  if (!Number.isInteger(id)) die(USAGE);
  try {
    const j = requestCancel(connect(), id, "cli");
    console.log(`job ${id}: ${j.state === "cancelled" ? "cancelled" : "cancel requested"}`);
  } catch (e) {
    if (e instanceof JobError) die(e.message);
    throw e;
  }
}

const SUB: Record<string, (args: string[]) => Promise<void> | void> = { serve, exec, steps, enqueue: enqueueCmd, jobs, cancel };

export const commands = {
  pipeline: { summary: "pipeline switch and limits: on | off | status | limit <step> --per-day N | resume <stage>", run: (args: string[]) => pipeline(args) },
  runner: {
    summary: "pipeline runner: serve | steps | enqueue | jobs | cancel",
    run: async (args: string[]) => {
      const f = args[0] ? SUB[args[0]] : undefined;
      if (!f) die(USAGE);
      await f(args.slice(1));
    },
  },
};

const PIPELINE_USAGE = `usage: autocraft pipeline on | off | status
       autocraft pipeline limit <step> --per-day <N|none>
       autocraft pipeline limit reset <step>|--all
       autocraft pipeline resume <fixup|cifix|fixissue|merge>
       autocraft pipeline pilot set <repo#number>... | show | clear`;

// Recorded as `cli`: only someone with a shell on the host can run this.
async function pipeline(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  const db = connect();
  if (sub === "on" || sub === "off") {
    setEnabled(db, sub === "on", "cli");
    audit(db, "cli", "pipeline-switch", "pipeline", { enabled: sub === "on" });
    console.log(`pipeline ${sub}`);
  } else if (sub === "resume") {
    if (rest.length !== 1) die(PIPELINE_USAGE);
    try {
      resumeStage(db, rest[0]!, "cli");
      console.log(`${rest[0]} resumed`);
    } catch (e) {
      if (e instanceof TripError) die(e.message);
      throw e;
    }
  } else if (sub === "limit" && rest[0] === "reset") {
    const target = rest[1] === "--all" ? "all" : rest[1];
    if (!target || rest.length > 2) die(PIPELINE_USAGE);
    try {
      const { steps } = resetLimitCount(db, target, "cli");
      console.log(`reset today's count of ${steps.length === 1 ? steps[0] : `${steps.length} stages`}`);
    } catch (e) {
      if (e instanceof LimitError) die(e.message);
      throw e;
    }
  } else if (sub === "limit") {
    const step = rest[0], n = rest[rest.indexOf("--per-day") + 1];
    if (!step || rest.indexOf("--per-day") < 0 || n === undefined) die(PIPELINE_USAGE);
    try {
      setLimit(db, step, { perDay: n === "none" ? null : Number(n) }, "cli");
    } catch (e) {
      if (e instanceof LimitError) die(e.message);
      throw e;
    }
  } else if (sub === "pilot") {
    const [action, ...refs] = rest;
    if (action === "set" && refs.length) {
      try {
        setPilot(db, "cli", refs);
      } catch (e) {
        if (e instanceof PilotError) die(e.message);
        throw e;
      }
    } else if (action === "clear") setPilot(db, "cli", []);
    else if (action !== "show") die(PIPELINE_USAGE);
    const p = pilotItems(db);
    console.log(p.length ? `pilot: ${p.length} items: ${p.join(" ")}` : "no pilot");
    return;
  } else if (sub !== "status") die(PIPELINE_USAGE);
  const s = await pipelineState(db);
  console.log(`pipeline ${s.enabled ? "ON" : "OFF"}${s.changedAt ? ` (set by ${s.changedBy} at ${s.changedAt.slice(0, 16)})` : ""}`);
  for (const l of s.limits) {
    console.log(`${l.step.padEnd(14)} ${String(l.usedToday).padStart(5)} / ${l.perDay === null ? "no limit" : l.perDay}${l.pausedReason ? `  ${l.pausedReason}` : ""}`);
  }
}
