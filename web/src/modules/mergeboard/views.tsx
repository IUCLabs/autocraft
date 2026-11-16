// Merge queue board: every PR with a take or take-fix review, laid out by the step it waits on before it merges.
import { useEffect, useMemo, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ArrowRightIcon, CaretRightIcon } from "@phosphor-icons/react";
import { useQuery } from "../../api/client";
import type { HomeDone, NextMerge, QueueRow, QueueState } from "../../api/types";
import { Badge } from "../../ui/atoms/Badge";
import { TimeAgo } from "../../ui/atoms/TimeAgo";
import { ItemRef } from "../../ui/molecules/ItemRef";
import { RepoSelect } from "../../ui/molecules/RepoSelect";
import { cn } from "../../ui/cn";
import { num } from "../../lib/format";
import { itemPath } from "../../lib/links";
import { ErrorLine } from "../admin/parts";
import { FastMark } from "../queue/fastTrack";
import { STATE } from "../queue/mergeParts";
import { usePage } from "../queue/usePage";

type LaneId = "verify" | "ci" | "premerge" | "ready" | "batch";

/** The steps a PR passes on its way to merged, in order. */
const LANES: { id: LaneId; label: string; hint: string; states: QueueState[] }[] = [
  { id: "verify", label: "Verify", hint: "Build and tests run at the reviewed head", states: ["waiting-verify"] },
  { id: "ci", label: "CI", hint: "Upstream CI at the head, a red default branch, or CI runs waiting for approval", states: ["waiting-ci", "waiting-main-ci", "ci-approval"] },
  { id: "premerge", label: "Pre-merge review", hint: "Opus reviews the head commit once more before it merges", states: ["waiting-premerge"] },
  { id: "ready", label: "Ready", hint: "Covered by the merge rule or approved by an operator; merges on the next run", states: ["ready", "decision-answered-merge"] },
  { id: "batch", label: "In a batch", hint: "Lands with an integration batch once its checks are green", states: ["batch-checking", "in-batch"] },
];

/** States that stop a PR until something changes: a person, a fix-up or a new head. */
const BLOCKED: QueueState[] = ["refused", "ci-failed", "conflict", "needs-fix-up", "verify-failed", "verify-error", "needs-decision", "batch-failed", "changes-requested"];

const LANE_OF = new Map<QueueState, LaneId>(LANES.flatMap((l) => l.states.map((s) => [s, l.id] as const)));
const key = (r: { repo: string; number: number }) => `${r.repo}#${r.number}`;

type Row = QueueRow & { held?: boolean; batch?: string };
type Next = Map<string, { position: number; merge: NextMerge }>;

/** A narrow card's head: the PR reference on one line, the title below it; the whole card opens the item. */
function CardHead({ repo, number, title, lead }: { repo: string; number: number; title: string; lead?: ReactNode }) {
  return (
    <>
      <div className="flex items-center gap-1.5">
        {lead}
        <Link to={itemPath(repo, number)} className="code min-w-0 truncate text-2xs text-ink/55 after:absolute after:inset-0">
          {repo}#{number}
        </Link>
      </div>
      <div className="mt-0.5 line-clamp-3 text-sm leading-snug" title={title}>
        {title}
      </div>
    </>
  );
}

function Card({ r, next }: { r: Row; next: Next }) {
  const n = next.get(key(r));
  return (
    <li className="relative min-w-0 rounded border border-line bg-panel px-3 py-2 hover:bg-ink/[0.03]">
      <CardHead
        repo={r.repo}
        number={r.number}
        title={r.title}
        lead={
          n && (
            <span title={`Merges ${n.position === 1 ? "next" : `as number ${n.position}`}`} className="num shrink-0 rounded bg-accent/15 px-1 text-2xs font-semibold text-accent-ink">
              {n.position}
            </span>
          )
        }
      />
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-2xs text-ink/55">
        <FastMark fast={n?.merge.fast} />
        <span title="Size">{r.size}</span>
        {r.fixes > 0 && <span>· {r.fixes} fix{r.fixes === 1 ? "" : "es"}</span>}
        {r.path === "operator" && <span>· approved by operator</span>}
        {r.batch && <span className="font-mono [overflow-wrap:anywhere]">· {r.batch}</span>}
      </div>
      <div className="mt-1 text-2xs text-ink/60" title={STATE[r.state]?.[2]}>
        {n?.merge.label ?? STATE[r.state]?.[0]}
      </div>
    </li>
  );
}

function Lane({ label, hint, rows, next }: { label: string; hint: string; rows: Row[]; next: Next }) {
  return (
    <section className="flex min-w-0 flex-col">
      <header className="flex items-center gap-2 pb-2" title={hint}>
        <h2 className="text-sm font-semibold">{label}</h2>
        <span className="num rounded-full bg-ink/[0.07] px-1.5 text-2xs text-ink/70">{num(rows.length)}</span>
        <ArrowRightIcon className="ml-auto text-ink/30 max-xl:hidden" aria-hidden />
      </header>
      <ul className="flex min-h-16 flex-col gap-2 rounded-md bg-ink/[0.025] p-2">
        {rows.length === 0 && <li className="px-1 py-3 text-center text-2xs text-ink/40">Empty</li>}
        {rows.map((r) => (
          <Card key={key(r)} r={r} next={next} />
        ))}
      </ul>
    </section>
  );
}

function MergedLane({ done, repo }: { done: HomeDone[] | undefined; repo: string | null }) {
  const merged = (done ?? []).filter((d) => d.what === "merged" && d.kind === "pr" && (!repo || d.repo === repo));
  return (
    <section className="flex min-w-0 flex-col">
      <header className="flex items-center gap-2 pb-2" title="Recently merged pull requests">
        <h2 className="text-sm font-semibold">Merged</h2>
        <span className="num rounded-full bg-merged/15 px-1.5 text-2xs text-merged">{num(merged.length)}</span>
      </header>
      <ul className="flex min-h-16 flex-col gap-2 rounded-md bg-merged/[0.05] p-2">
        {merged.length === 0 && <li className="px-1 py-3 text-center text-2xs text-ink/40">Nothing merged lately</li>}
        {merged.map((d) => (
          <li key={key(d)} className="relative rounded border border-line bg-panel px-3 py-2 hover:bg-ink/[0.03]">
            <CardHead repo={d.repo} number={d.number} title={d.title} />
            <TimeAgo iso={d.at} className="num mt-1 block text-2xs text-ink/50" />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The share of the queue at each step, as one bar. */
function FlowBar({ counts, total }: { counts: { id: string; label: string; n: number; tone: string }[]; total: number }) {
  if (total === 0) return null;
  return (
    <div className="mt-4">
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-ink/[0.06]" role="img" aria-label={counts.map((c) => `${c.label} ${c.n}`).join(", ")}>
        {counts.filter((c) => c.n > 0).map((c) => (
          <div key={c.id} className={cn("h-full border-r border-bg last:border-0", c.tone)} style={{ width: `${(c.n / total) * 100}%` }} title={`${c.label}: ${c.n}`} />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink/60">
        {counts.map((c) => (
          <span key={c.id} className="inline-flex items-center gap-1.5">
            <span className={cn("size-2 rounded-full", c.tone)} aria-hidden />
            {c.label} <span className="num text-ink/80">{num(c.n)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

const LANE_TONE: Record<LaneId | "blocked", string> = { verify: "bg-c1", ci: "bg-c2", premerge: "bg-c3", ready: "bg-ok", batch: "bg-accent", blocked: "bg-bad" };

function Blocked({ rows }: { rows: Row[] }) {
  if (rows.length === 0) return null;
  return (
    <section className="mt-6 rounded-md border border-line">
      <header className="flex items-center gap-2 border-b border-line px-4 py-2">
        <h2 className="text-sm font-semibold">Stopped</h2>
        <span className="num rounded-full bg-bad/15 px-1.5 text-2xs text-bad">{num(rows.length)}</span>
        <span className="text-xs text-ink/50">wait for a person, a fix-up or a new head</span>
      </header>
      <ul>
        {rows.map((r) => {
          const [label, tone, hint] = r.held ? ["Merge held by an operator", "warn" as const, "An operator holds the merge"] : STATE[r.state];
          return (
            <li key={key(r)} className="relative flex flex-wrap items-start gap-x-3 gap-y-1 border-b border-line px-4 py-2 last:border-0 hover:bg-ink/[0.03]">
              <ItemRef repo={r.repo} number={r.number} kind="pr" state="open" title={r.title} stretch className="min-w-[12rem] flex-1" />
              <span title={hint}>
                <Badge tone={tone}>{label}</Badge>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function MergeBoardView() {
  const [params, setParams] = useSearchParams();
  const repo = params.get("repo");
  const { pages, error, hasMore, loadingMore, loadMore } = usePage("merge", repo ?? "pipeline", undefined);
  const home = useQuery("home", (a) => a.home());
  // The board shows the whole queue, so every page is read.
  useEffect(() => {
    if (hasMore && !loadingMore) loadMore();
  }, [hasMore, loadingMore, loadMore]);

  const board = useMemo(() => {
    const first = pages?.[0];
    const rows = new Map<string, Row>();
    for (const b of first?.batches ?? []) for (const r of b.prs) rows.set(key(r), { ...r, batch: b.branch });
    for (const r of pages?.flatMap((p) => p.mergeRows) ?? []) if (!rows.has(key(r))) rows.set(key(r), r);
    const next: Next = new Map((first?.nextMerges ?? []).map((merge, i) => [key(merge), { position: i + 1, merge }]));
    const lanes = new Map<LaneId, Row[]>(LANES.map((l) => [l.id, []]));
    const blocked: Row[] = [];
    for (const r of rows.values()) {
      if (r.held || BLOCKED.includes(r.state)) blocked.push(r);
      else {
        const lane = LANE_OF.get(r.state);
        if (lane) lanes.get(lane)!.push(r);
      }
    }
    // PRs in "Next merges" first, in merge order.
    const pos = (r: Row) => next.get(key(r))?.position ?? Infinity;
    for (const l of lanes.values()) l.sort((a, b) => pos(a) - pos(b));
    return { lanes, blocked, next, loaded: !!first };
  }, [pages]);

  const counts = [
    ...LANES.map((l) => ({ id: l.id, label: l.label, n: board.lanes.get(l.id)!.length, tone: LANE_TONE[l.id] })),
    { id: "blocked", label: "Stopped", n: board.blocked.length, tone: LANE_TONE.blocked },
  ];
  const total = counts.reduce((s, c) => s + c.n, 0);
  const setRepo = (r: string | null) => setParams((p) => (r ? p.set("repo", r) : p.delete("repo"), p), { replace: true });

  return (
    <WidePage title="Merge queue" sub={board.loaded ? `${num(total)} PR${total === 1 ? "" : "s"} approved for merging` : undefined}>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="max-w-[60ch] text-sm text-ink/60">Every PR with a take review, by the step it waits on. A PR moves left to right until it merges.</p>
        <div className="flex items-center gap-3">
          <Link to="/next/merge" className="inline-flex items-center gap-1 text-sm text-accent-ink hover:underline max-md:h-11">
            Details <CaretRightIcon size={12} />
          </Link>
          <RepoSelect value={repo} onChange={setRepo} />
        </div>
      </div>
      <ErrorLine error={error?.message ?? home.error?.message} className="mt-3" />
      <FlowBar counts={counts} total={total} />
      {board.loaded && (
        <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          {LANES.map((l) => (
            <Lane key={l.id} label={l.label} hint={l.hint} rows={board.lanes.get(l.id)!} next={board.next} />
          ))}
          <MergedLane done={home.data?.done} repo={repo} />
        </div>
      )}
      <Blocked rows={board.blocked} />
    </WidePage>
  );
}

/** Like Page, but wider: six lanes side by side need the room. */
function WidePage({ title, sub, children }: { title: string; sub?: ReactNode; children: ReactNode }) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1680px] px-4 pb-12 pt-5 md:px-6">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <h1 className="text-xl font-semibold">{title}</h1>
          {sub && <span className="text-sm text-ink/55">{sub}</span>}
        </div>
        {children}
      </div>
    </div>
  );
}
