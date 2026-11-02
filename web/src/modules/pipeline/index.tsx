// The Pipeline page: what runs, when, what it did and what it cost. Everyone
// signed in sees it; only operators start, cancel or schedule steps. The page
// writes job requests; the runner process does the work.
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowLeftIcon, PlayIcon, WorkflowIcon } from "lucide-react";
import { useApi, useQuery } from "../../api/client";
import type { Job, JobParams, JobState, PipelineOverview, PipelineStage, PipelineStep, Schedule, ScheduleTrigger, StepParam, SyncRun } from "../../api/types";
import type { FeatureModule, ViewProps } from "../../registry/types";
import { can } from "../../registry/permissions";
import { Badge, type Tone } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import { cn } from "../../ui/cn";
import { ago, num } from "../../lib/format";
import { Block, ConfirmButton, ErrorLine, Page, selectCls, TextInput, useWrite, when } from "../admin/parts";

// ---- helpers -------------------------------------------------------------------

/** Refetches every `ms` while `active`. */
function usePoll(refetch: () => void, ms: number, active = true) {
  const ref = useRef(refetch);
  ref.current = refetch;
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => ref.current(), ms);
    return () => clearInterval(t);
  }, [ms, active]);
}

const STATE_TONE: Record<JobState, Tone> = { queued: "neutral", running: "accent", done: "ok", failed: "bad", cancelled: "warn" };
const STATE_LABEL: Record<JobState, string> = { queued: "Queued", running: "Running", done: "Done", failed: "Failed", cancelled: "Cancelled" };
export const JobBadge = ({ j }: { j: Job }) => (
  <Badge tone={STATE_TONE[j.state]}>{j.state === "running" && j.cancelRequested ? "Stopping" : STATE_LABEL[j.state]}</Badge>
);

const STAGE_TONE: Record<PipelineStage["state"], Tone> = { running: "accent", queued: "neutral", ok: "ok", failed: "bad", idle: "neutral", planned: "neutral" };
const STAGE_LABEL: Record<PipelineStage["state"], string> = { running: "Running", queued: "Queued", ok: "OK", failed: "Last run failed", idle: "Not run yet", planned: "Planned" };

function took(a: string | null, b: string | null): string {
  if (!a) return "–";
  const s = Math.max(0, Math.round(((b ? Date.parse(b) : Date.now()) - Date.parse(a)) / 1000));
  return s >= 3600 ? `${(s / 3600).toFixed(1)} h` : s >= 60 ? `${Math.round(s / 60)} min` : `${s} s`;
}

const usd = (v: number | null) => (v === null ? null : `$${v.toFixed(2)}`);
function cost(j: Job): string {
  if (!j.usage || !j.usage.calls) return "–";
  const tokens = num(j.usage.input + j.usage.output);
  return usd(j.usage.costUsd) ? `${usd(j.usage.costUsd)} · ${tokens} tok` : `${tokens} tok`;
}

const paramText = (p: JobParams) =>
  Object.entries(p)
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");

function scheduleText(s: Schedule): string {
  if (!s.enabled) return "Not scheduled";
  const base = s.trigger === "after-sync" ? "After each sync" : `Every ${s.intervalMinutes} min`;
  const p = paramText(s.params);
  return p ? `${base} (${p})` : base;
}

// ---- param fields ----------------------------------------------------------------

type Values = Record<string, string>;

const initial = (params: StepParam[], from?: JobParams): Values =>
  Object.fromEntries(params.map((p) => [p.name, from?.[p.name] !== undefined ? String(from[p.name]) : "default" in p && p.default !== undefined ? String(p.default) : ""]));

function toParams(params: StepParam[], v: Values): JobParams {
  const out: JobParams = {};
  for (const p of params) {
    const s = (v[p.name] ?? "").trim();
    if (!s) continue;
    out[p.name] = p.kind === "int" ? Number(s) : s;
  }
  return out;
}

function ParamFields({ params, values, onChange, disabled, idPrefix }: { params: StepParam[]; values: Values; onChange: (v: Values) => void; disabled?: boolean; idPrefix: string }) {
  return (
    <>
      {params.map((p) => {
        const id = `${idPrefix}-${p.name}`;
        const set = (x: string) => onChange({ ...values, [p.name]: x });
        const v = values[p.name] ?? "";
        return (
          <label key={p.name} htmlFor={id} className="flex flex-col gap-1 text-xs text-ink/60">
            <span>
              {p.label}
              {p.help && <span className="text-ink/40"> · {p.help}</span>}
            </span>
            {p.kind === "enum" || p.kind === "repo" ? (
              <select id={id} value={v} disabled={disabled} onChange={(e) => set(e.target.value)} className={cn(selectCls, "min-w-36 text-ink")}>
                {(p.kind === "repo" || !p.required) && <option value="">{p.kind === "repo" ? "Choose a repo" : "Default"}</option>}
                {p.options.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            ) : p.kind === "int" ? (
              <TextInput id={id} type="number" inputMode="numeric" min={p.min} max={p.max} step={1} value={v} disabled={disabled} onChange={(e) => set(e.target.value)} className="w-28 text-ink" />
            ) : (
              <TextInput id={id} value={v} disabled={disabled} pattern="[a-z0-9][a-z0-9\-]{0,47}" maxLength={48} placeholder="org-1102" onChange={(e) => set(e.target.value)} className="w-40 text-ink" />
            )}
          </label>
        );
      })}
    </>
  );
}

// ---- steps ---------------------------------------------------------------------

function RunForm({ step }: { step: PipelineStep }) {
  const api = useApi();
  const navigate = useNavigate();
  const [values, setValues] = useState(() => initial(step.params));
  const write = useWrite();
  const blocked = step.unavailable !== null;
  return (
    <form
      className="mt-3 flex flex-wrap items-end gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        let id = 0;
        void write
          .run("run", async () => {
            id = (await api.pipeline.run(step.name, toParams(step.params, values))).id;
          })
          .then((ok) => ok && navigate(`/pipeline/${id}`));
      }}
    >
      <ParamFields params={step.params} values={values} onChange={setValues} disabled={blocked} idPrefix={`run-${step.name}`} />
      <Button type="submit" variant="primary" icon={PlayIcon} disabled={blocked} loading={write.busy === "run"} className="max-md:h-11">
        Run now
      </Button>
      <ErrorLine error={write.error} className="basis-full" />
    </form>
  );
}

function ScheduleEditor({ step, onDone }: { step: PipelineStep; onDone: () => void }) {
  const api = useApi();
  const s = step.schedule;
  const [enabled, setEnabled] = useState(s.enabled);
  const [trigger, setTrigger] = useState<ScheduleTrigger>(s.trigger);
  const [minutes, setMinutes] = useState(String(s.intervalMinutes ?? 60));
  const [values, setValues] = useState(() => initial(step.params, s.params));
  const write = useWrite();
  return (
    <form
      className="mt-3 rounded border border-line bg-ink/[0.02] p-3"
      onSubmit={(e) => {
        e.preventDefault();
        void write
          .run("schedule", () =>
            api.pipeline.schedule(step.name, { enabled, trigger, intervalMinutes: trigger === "interval" ? Number(minutes) : null, params: toParams(step.params, values) }),
          )
          .then((ok) => ok && onDone());
      }}
    >
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex h-8 items-center gap-2 text-sm max-md:h-11">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="size-4 accent-[rgb(var(--st-accent-rgb))]" />
          On
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink/60">
          When
          <select value={trigger} onChange={(e) => setTrigger(e.target.value as ScheduleTrigger)} className={cn(selectCls, "text-ink")}>
            <option value="interval">Every few minutes</option>
            <option value="after-sync">After each sync</option>
          </select>
        </label>
        {trigger === "interval" && (
          <label className="flex flex-col gap-1 text-xs text-ink/60">
            Minutes
            <TextInput type="number" min={5} max={10080} value={minutes} onChange={(e) => setMinutes(e.target.value)} className="w-24 text-ink" />
          </label>
        )}
        <ParamFields params={step.params} values={values} onChange={setValues} idPrefix={`sched-${step.name}`} />
        <div className="flex gap-2">
          <Button type="submit" loading={write.busy === "schedule"} className="max-md:h-11">
            Save
          </Button>
          <Button type="button" variant="ghost" onClick={onDone} className="max-md:h-11">
            Close
          </Button>
        </div>
      </div>
      <p className="mt-2 text-xs text-ink/50">A scheduled job is not queued while another job of the same step is waiting or running.</p>
      <ErrorLine error={write.error} className="mt-2" />
    </form>
  );
}

const GROUP_LABEL: Record<string, string> = { models: "Uses model quota", "github-write": "Writes to GitHub", local: "Runs locally" };

function StepCard({ step, operator }: { step: PipelineStep; operator: boolean }) {
  const [editing, setEditing] = useState(false);
  const last = step.lastJob;
  return (
    <section className="min-w-0 rounded-md border border-line p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">{step.title}</h3>
        <span className="code text-xs text-ink/50">{step.name}</span>
        <Badge tone={step.group === "github-write" ? "warn" : "neutral"}>{GROUP_LABEL[step.group] ?? step.group}</Badge>
        {step.unavailable && <Badge tone="warn">Not available</Badge>}
      </div>
      <p className="mt-1.5 max-w-[80ch] text-sm text-ink/70">{step.description}</p>
      {step.unavailable && <p className="mt-1 text-sm text-warn">{step.unavailable}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink/55">
        <span>
          Last run:{" "}
          {last ? (
            <Link to={`/pipeline/${last.id}`} className="text-ink/80 underline-offset-2 hover:underline">
              #{last.id} {STATE_LABEL[last.state].toLowerCase()} {ago(last.endedAt ?? last.startedAt ?? last.requestedAt, false)}
            </Link>
          ) : (
            "never"
          )}
        </span>
        <span>
          Schedule: <span className="text-ink/80">{scheduleText(step.schedule)}</span>
          {step.schedule.enabled && step.schedule.lastEnqueuedAt && <> · last queued {ago(step.schedule.lastEnqueuedAt, false)}</>}
        </span>
        {operator && !editing && (
          <button className="text-accent-ink underline-offset-2 hover:underline max-md:py-2" onClick={() => setEditing(true)}>
            Edit schedule
          </button>
        )}
      </div>
      {operator && editing && <ScheduleEditor step={step} onDone={() => setEditing(false)} />}
      {operator && <RunForm step={step} />}
    </section>
  );
}

// ---- stages, sync ----------------------------------------------------------------

function Stages({ o }: { o: PipelineOverview }) {
  const title = (s: PipelineStage) => (s.mode === "automatic" ? ["sync (timer)", ...s.steps] : s.steps).join(", ");
  return (
    <ol className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
      {o.stages.map((s) => (
        <li key={s.n} className={cn("min-w-0 rounded-md border border-line px-3 py-2.5", s.mode === "planned" && "border-dashed text-ink/55")}>
          <div className="flex items-baseline gap-1.5">
            <span className="num text-xs text-ink/45">{s.n}</span>
            <span className="truncate text-sm font-medium">{s.name}</span>
          </div>
          <div className="mt-1.5">
            <Badge tone={STAGE_TONE[s.state]}>{STAGE_LABEL[s.state]}</Badge>
          </div>
          <div className="code mt-1.5 truncate text-2xs text-ink/50" title={title(s)}>
            {s.mode === "planned" ? "no steps yet" : title(s)}
          </div>
        </li>
      ))}
    </ol>
  );
}

function SyncRuns({ runs, last }: { runs: SyncRun[]; last: string | null }) {
  return (
    <Block flush title="Sync" aside={last ? `last finished ${ago(last, false)}; runs on its own timer` : "runs on its own timer"}>
      {runs.length === 0 ? (
        <p className="p-4 text-sm text-ink/50">No sync runs recorded yet.</p>
      ) : (
        <table className="num w-full min-w-[520px] text-sm">
          <thead className="bg-ink/[0.03] text-xs text-ink/55">
            <tr>
              <th className="h-8 px-3 text-left font-medium">Started (UTC)</th>
              <th className="h-8 px-3 text-right font-medium">Took</th>
              <th className="h-8 px-3 text-left font-medium">Mode</th>
              <th className="h-8 px-3 text-right font-medium">Items</th>
              <th className="h-8 px-3 text-left font-medium">Result</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.startedAt} className="h-8 border-t border-line">
                <td className="px-3">{when(r.startedAt)}</td>
                <td className="px-3 text-right">{r.endedAt ? took(r.startedAt, r.endedAt) : "–"}</td>
                <td className="px-3">{r.mode ?? "–"}</td>
                <td className="px-3 text-right">{r.items === null ? "–" : num(r.items)}</td>
                <td className="px-3">{r.error ? <span className="text-bad">{r.error}</span> : r.endedAt ? "OK" : <span className="text-ink/55">running</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Block>
  );
}

// ---- jobs ----------------------------------------------------------------------

const FILTERS: (JobState | "")[] = ["", "queued", "running", "done", "failed", "cancelled"];

function Jobs({ selected }: { selected?: number }) {
  const navigate = useNavigate();
  const [state, setState] = useState<JobState | "">("");
  const [limit, setLimit] = useState(25);
  const q = useQuery(`pipeline-jobs:${state}:${limit}`, (a) => a.pipeline.jobs({ state: state || undefined, limit }));
  const active = q.data?.jobs.some((j) => j.state === "queued" || j.state === "running") ?? false;
  usePoll(q.refetch, active ? 3000 : 15000);
  return (
    <Block
      flush
      title="Jobs"
      aside={
        <div role="radiogroup" aria-label="Show" className="flex flex-wrap items-center gap-1">
          {FILTERS.map((f) => (
            <button key={f || "all"} role="radio" aria-checked={state === f} data-active={state === f} className="chip" onClick={() => setState(f)}>
              {f ? STATE_LABEL[f] : "All"}
            </button>
          ))}
        </div>
      }
    >
      <ErrorLine error={q.error?.message} className="p-4" />
      {q.data && q.data.jobs.length === 0 && <p className="p-4 text-sm text-ink/50">No jobs.</p>}
      {q.data && q.data.jobs.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="bg-ink/[0.03] text-xs text-ink/55">
              <tr>
                <th className="h-8 w-14 px-3 text-left font-medium">Job</th>
                <th className="h-8 px-3 text-left font-medium">Step</th>
                <th className="h-8 w-24 px-3 text-left font-medium">State</th>
                <th className="h-8 px-3 text-left font-medium">Requested</th>
                <th className="h-8 px-3 text-right font-medium">Took</th>
                <th className="h-8 px-3 text-left font-medium">Result</th>
                <th className="h-8 px-3 text-right font-medium">Cost</th>
              </tr>
            </thead>
            <tbody>
              {q.data.jobs.map((j) => (
                <tr
                  key={j.id}
                  onClick={() => navigate(`/pipeline/${j.id}`)}
                  aria-selected={selected === j.id}
                  className={cn("h-9 cursor-pointer border-t border-line hover:bg-ink/[0.03]", selected === j.id && "bg-accent/[0.07]")}
                >
                  <td className="num px-3">
                    <Link to={`/pipeline/${j.id}`} onClick={(e) => e.stopPropagation()} className="underline-offset-2 hover:underline">
                      #{j.id}
                    </Link>
                  </td>
                  <td className="px-3">
                    <span className="code">{j.step}</span>
                    {Object.keys(j.params).length > 0 && <span className="ml-1.5 text-xs text-ink/45">{paramText(j.params)}</span>}
                  </td>
                  <td className="px-3">
                    <JobBadge j={j} />
                  </td>
                  <td className="whitespace-nowrap px-3 text-ink/65" title={j.requestedAt}>
                    {j.requestedBy} · {ago(j.requestedAt)}
                  </td>
                  <td className="num px-3 text-right">{took(j.startedAt, j.endedAt)}</td>
                  <td className="max-w-[340px] truncate px-3 text-ink/70" title={j.error ?? j.summary ?? j.progress ?? ""}>
                    {j.state === "failed" ? <span className="text-bad">{j.error}</span> : (j.summary ?? j.progress ?? "")}
                  </td>
                  <td className="num whitespace-nowrap px-3 text-right text-ink/65">{cost(j)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {q.data.total > q.data.jobs.length && (
            <div className="border-t border-line p-2 text-center">
              <Button size="sm" variant="ghost" onClick={() => setLimit((l) => l + 25)}>
                Show more ({num(q.data.total - q.data.jobs.length)} older)
              </Button>
            </div>
          )}
        </div>
      )}
    </Block>
  );
}

// ---- views -----------------------------------------------------------------------

function RunnerLine({ o }: { o: PipelineOverview }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn("size-2 rounded-full", o.runner.alive ? "bg-ok" : "bg-bad")} aria-hidden />
      {o.runner.alive ? "Runner running" : o.runner.lastSeen ? `Runner not running since ${ago(o.runner.lastSeen, false)}: jobs wait until it starts` : "Runner not started: jobs wait until it starts"}
      {" · "}
      {o.counts.running} running, {o.counts.queued} queued
    </span>
  );
}

function PipelineView({ user, params }: ViewProps) {
  const q = useQuery("pipeline", (a) => a.pipeline.overview());
  const operator = can(user, "operator");
  const busy = (q.data?.counts.running ?? 0) + (q.data?.counts.queued ?? 0) > 0;
  usePoll(q.refetch, busy ? 4000 : 20000);
  const o = q.data;
  const selected = params.id ? Number(params.id) : undefined;
  const byStage = useMemo(() => [...(o?.steps ?? [])].sort((a, b) => a.stage - b.stage), [o]);
  return (
    <Page title="Pipeline" sub={o && <RunnerLine o={o} />}>
      <p className="mt-2 max-w-[80ch] text-sm text-ink/65">
        Every pipeline step runs here as a job, started from this page or by a schedule. {operator ? "As an operator you can start, stop and schedule steps; each request is in the audit log." : "Only operators start, stop or schedule steps; you can see what runs, what it did and what it cost."}
      </p>
      <ErrorLine error={q.error?.message} className="mt-3" />
      {o && <Stages o={o} />}
      <div className="mt-5">
        <Jobs selected={selected} />
      </div>
      <h2 className="mb-2 mt-6 text-sm font-semibold">Steps</h2>
      <div className="flex flex-col gap-3">
        {byStage.map((s) => (
          <StepCard key={s.name} step={s} operator={operator} />
        ))}
      </div>
      {o && (
        <div className="mt-6">
          <SyncRuns runs={o.sync.runs} last={o.sync.lastFinishedAt} />
        </div>
      )}
    </Page>
  );
}

function JobPanel({ params, user }: ViewProps) {
  const id = params.id ? Number(params.id) : null;
  if (!id) return <div className="grid h-full place-items-center p-6 text-sm text-ink/50">Pick a job to see its progress and log.</div>;
  return <JobDetailView key={id} id={id} operator={can(user, "operator")} />;
}

function JobDetailView({ id, operator, back }: { id: number; operator: boolean; back?: boolean }) {
  const api = useApi();
  const q = useQuery(`pipeline-job:${id}`, (a) => a.pipeline.job(id));
  const j = q.data;
  const live = !j || j.state === "queued" || j.state === "running";
  usePoll(q.refetch, 2000, live);
  const write = useWrite();
  const logRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [j?.log]);
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="border-b border-line px-4 py-3">
        {back && (
          <Link to="/pipeline" className="mb-2 inline-flex items-center gap-1 text-xs text-ink/60 max-md:py-2">
            <ArrowLeftIcon className="size-3.5" /> Pipeline
          </Link>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-base font-semibold">Job #{id}</h2>
          {j && <span className="code text-sm text-ink/70">{j.step}</span>}
          {j && <JobBadge j={j} />}
          {j && operator && (j.state === "queued" || j.state === "running") && !j.cancelRequested && (
            <ConfirmButton className="ml-auto" label={j.state === "queued" ? "Cancel" : "Stop"} confirmLabel={j.state === "queued" ? "Cancel this job" : "Stop this job"} loading={write.busy === "cancel"} onConfirm={() => void write.run("cancel", () => api.pipeline.cancel(id))} />
          )}
        </div>
        <ErrorLine error={write.error ?? q.error?.message} className="mt-2" />
      </div>
      {j && (
        <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-ink/55">Settings</dt>
            <dd className="code">{paramText(j.params) || "defaults"}</dd>
            <dt className="text-ink/55">Requested</dt>
            <dd>
              {j.requestedBy} · {when(j.requestedAt)} UTC
            </dd>
            <dt className="text-ink/55">Ran</dt>
            <dd>{j.startedAt ? `${when(j.startedAt)} UTC, ${j.endedAt ? `took ${took(j.startedAt, j.endedAt)}` : `running for ${took(j.startedAt, null)}`}` : "not started"}</dd>
            {j.usage && j.usage.calls > 0 && (
              <>
                <dt className="text-ink/55">Model use</dt>
                <dd className="num">
                  {num(j.usage.calls)} calls · {num(j.usage.input)} in / {num(j.usage.output)} out{usd(j.usage.costUsd) ? ` · ${usd(j.usage.costUsd)}` : ""}
                </dd>
              </>
            )}
          </dl>
          {j.cancelRequested && j.state === "running" && <p className="text-sm text-warn">Stop requested; the runner is ending the job.</p>}
          {j.progress && j.state === "running" && <p className="text-sm">{j.progress}</p>}
          {j.summary && <p className="rounded border border-ok/30 bg-ok/5 px-3 py-2 text-sm">{j.summary}</p>}
          {j.error && <p className="rounded border border-bad/30 bg-bad/5 px-3 py-2 text-sm text-bad">{j.error}</p>}
          <div className="flex min-h-[240px] flex-1 flex-col">
            <div className="mb-1 flex items-baseline gap-2 text-xs text-ink/55">
              Log{j.logTruncated && <span>(last part)</span>}
            </div>
            <pre ref={logRef} className="code min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded border border-line bg-sunken p-3 text-xs leading-relaxed">
              {j.log || (j.state === "queued" ? "Waiting for the runner." : "No log.")}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

function PhonePipeline(props: ViewProps) {
  if (props.params.id) return <JobDetailView id={Number(props.params.id)} operator={can(props.user, "operator")} back />;
  return <PipelineView {...props} />;
}

export const pipelineModule: FeatureModule = {
  id: "pipeline",
  permission: "viewer",
  nav: { label: "Pipeline", icon: WorkflowIcon, to: "/pipeline", group: "operator", order: 5 },
  routes: [
    {
      path: "pipeline/:id?",
      view: {
        id: "pipeline",
        title: "Pipeline",
        phone: PhonePipeline,
        panels: [
          { id: "main", title: "Pipeline", component: PipelineView, defaultSize: 62, minSize: 40 },
          { id: "job", title: "Job", component: JobPanel, defaultSize: 38, minSize: 24, collapsible: true },
        ],
      },
    },
  ],
};
