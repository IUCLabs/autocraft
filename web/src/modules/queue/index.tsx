// Merge queue: every PR with a take or take-fix review at its current head, and
// what it waits on. Read-only; merges are started from the Pipeline page.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronRightIcon, ChevronsDownUpIcon, ChevronsUpDownIcon, GitMergeIcon, XIcon } from "lucide-react";
import { useQuery, usePagedQuery } from "../../api/client";
import type { BatchList, BatchState, QueueBatch, QueueFilter, QueueList, QueueRow, QueueState, Tier } from "../../api/types";
import type { FeatureModule, ViewProps } from "../../registry/types";
import { Badge, type Tone } from "../../ui/Badge";
import { RefLink } from "../../ui/RefLink";
import { cn } from "../../ui/cn";
import { ago, num } from "../../lib/format";
import { useIsPhone } from "../../shell/useMedia";
import { Block, ErrorLine, Page, selectCls, useUrlState } from "../admin/parts";
import { useNow } from "../../lib/useNow";

export const STATE: Record<QueueState, [string, Tone, string]> = {
  ready: ["Ready", "ok", "Covered by the merge rule; merges on the next run"],
  "decision-answered-merge": ["Merge approved", "ok", "The operator answered merge at this head; merges on the next run"],
  refused: ["Refused", "bad", "The merge command or a pre-merge check said no; tried again next run"],
  "waiting-ci": ["Waiting for CI", "neutral", "CI is pending or hasn't run, or GitHub is still checking mergeability"],
  "ci-failed": ["CI failed", "bad", "CI fails at this head"],
  conflict: ["Conflict", "bad", "Conflicts with the base branch"],
  "needs-fix-up": ["Needs fix-up", "warn", "The review lists small fixes; a later step makes them"],
  "waiting-opus": ["Waiting for Opus", "neutral", "Sonnet rated it take or take-fix; the final review by Opus is not done at this head yet"],
  "waiting-verify": ["Waiting for Verify", "neutral", "No passed verification at this head yet: the build tasks are planned or running"],
  "verify-failed": ["Verify failed", "bad", "The build or tests failed at this head"],
  "verify-error": ["Verify error", "warn", "Verification could not run; it is retried once, then held"],
  "needs-decision": ["Needs a decision", "warn", "Outside the merge rule (size, label, author, not verified or no CI): waits for the operator's Merge? answer"],
  declined: ["Declined", "neutral", "The operator answered hold or close"],
  merged: ["Merged", "merged", "Merged"],
  "batch-checking": ["In batch: checking", "neutral", "Part of an integration batch whose combined tree is being built and tested in the sandbox"],
  "in-batch": ["In batch", "ok", "Part of an integration batch with an open PR; lands when upstream CI is green"],
  "batch-failed": ["Batch failed", "bad", "Failed alone in a batch: on hold until the PR has a new head"],
  "held-duplicate": ["Held: Duplicate?", "warn", "An open Duplicate? decision keeps it out of every later stage; answer it in Decisions"],
  "held-backlog": ["Backlog", "neutral", "Answered Backlog; reopen the decision to take it up again"],
};
const STATES = Object.keys(STATE) as QueueState[];
const TIER: Record<Tier, string> = { whitelisted: "whitelisted", not: "not whitelisted", "override-allow": "override allow", "override-deny": "override deny" };
const CI_TONE: Record<QueueRow["ci"], Tone> = { success: "ok", failure: "bad", pending: "warn", none: "neutral", unknown: "neutral" };
const MERGEABLE: Record<QueueRow["mergeable"], [string, Tone]> = { clean: ["clean", "ok"], conflicts: ["conflicts", "bad"], unknown: ["unknown", "neutral"] };

function useFilter() {
  const { state, update } = useUrlState();
  const filter: QueueFilter = {
    repo: state.repo || undefined,
    state: STATES.includes(state.state as QueueState) ? (state.state as QueueState) : undefined,
    flow: /^merge\.[a-z-]+$/.test(state.flow ?? "") ? state.flow : undefined,
  };
  return { filter, update };
}

// Pages append on "Show more"; a change refetches every loaded page, so the list keeps its length.
function usePagedQueue(filter: QueueFilter) {
  const q = usePagedQuery(`queue:${JSON.stringify(filter)}`, (api, after) => api.queue({ ...filter, after }), (p) => p.next);
  const last = q.pages?.[q.pages.length - 1];
  const data: QueueList | undefined = last && { ...last, rows: q.pages!.flatMap((p) => p.rows) };
  return { data, error: q.error, loading: q.loading || q.loadingMore, loadMore: q.loadMore };
}

function QueueView(_: ViewProps) {
  const { filter, update } = useFilter();
  const { data, error, loading, loadMore } = usePagedQueue(filter);
  const { data: repos } = useQuery("repos", (api) => api.repos());
  const phone = useIsPhone();
  // Merged PRs are listed only under their own state, so "any state" leaves them out.
  const all = data ? Object.entries(data.counts).reduce((a, [k, n]) => a + (k === "merged" ? 0 : n), 0) : undefined;
  const mergeable = data ? data.counts.ready + data.counts["decision-answered-merge"] : undefined;

  return (
    <Page
      title="Merge queue"
      sub={
        data && (
          <>
            {num(all!)} included PR{all === 1 ? "" : "s"} · {num(mergeable!)} may merge now · {num(data.counts["needs-decision"])} wait for a decision · merges run from the Pipeline page
          </>
        )
      }
    >
      <div className="mt-4 flex flex-wrap items-center gap-1.5">
        <select aria-label="Repo" value={filter.repo ?? ""} onChange={(e) => update({ repo: e.target.value || null })} className={cn(selectCls, filter.repo ? "text-accent-ink" : "text-ink/70")}>
          <option value="">Every repo</option>
          {repos?.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        {filter.flow ? (
          <button data-active className="chip max-md:h-11" onClick={() => update({ flow: null })} aria-label="Clear the flowchart branch">
            From the pipeline flow: Merge queue › {filter.flow.slice(6).replace(/-/g, " ")} <XIcon className="opacity-60" />
          </button>
        ) : phone ? (
          <select aria-label="State" value={filter.state ?? ""} onChange={(e) => update({ state: e.target.value || null })} className={cn(selectCls, filter.state ? "text-accent-ink" : "text-ink/70")}>
            <option value="">Any state{all !== undefined ? ` (${num(all)})` : ""}</option>
            {STATES.map((s) => (
              <option key={s} value={s}>
                {`${STATE[s][0]}${data ? ` (${num(data.counts[s])})` : ""}`}
              </option>
            ))}
          </select>
        ) : (
          <div role="group" aria-label="State" className="flex flex-wrap items-center gap-1">
            <button aria-pressed={!filter.state} data-active={!filter.state} className="chip max-md:h-11" onClick={() => update({ state: null })}>
              Any state <span className="num opacity-60">{all !== undefined ? num(all) : ""}</span>
            </button>
            {STATES.map((s) => (
              <button key={s} aria-pressed={filter.state === s} data-active={filter.state === s} title={STATE[s][2]} className="chip max-md:h-11" onClick={() => update({ state: filter.state === s ? null : s })}>
                {STATE[s][0]} <span className="num opacity-60">{data ? num(data.counts[s]) : ""}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {!filter.flow && <Batches repo={filter.repo} phone={phone} />}

      <Block className="mt-3" flush title={filter.state ? STATE[filter.state][0] : "Not in a batch"} aside={loading && data ? "Updating…" : filter.state ? STATE[filter.state][2] : undefined}>
        <ErrorLine error={error?.message} className="p-4" />
        {data && data.rows.length === 0 && <p className="px-4 py-6 text-sm text-ink/50">No PR in the queue matches these filters.</p>}
        {data && data.rows.length > 0 && (phone ? <Cards rows={data.rows} /> : <Table rows={data.rows} />)}
        {data?.next && (
          <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-2.5 text-xs text-ink/55">
            <span className="num">
              {num(data.rows.length)} of {num(data.total)}
            </span>
            <button className="chip max-md:h-11" disabled={loading} onClick={loadMore}>
              {loading ? "Loading…" : "Show more"}
            </button>
          </div>
        )}
      </Block>
    </Page>
  );
}

const BATCH_STATE: Record<BatchState, [string, Tone]> = {
  checking: ["Checking", "neutral"], open: ["PR open", "ok"], merged: ["Merged", "merged"], failed: ["Failed", "bad"], split: ["Split", "warn"], superseded: ["Rebuilt", "neutral"],
};

// Batches page in like the PR rows: newest first, "Show more" for the next page.
function usePagedBatches(repo: string | undefined) {
  const q = usePagedQuery(`queue-batches:${repo ?? ""}`, (api, after) => api.queueBatches({ repo, after }), (p) => p.next);
  const last = q.pages?.[q.pages.length - 1];
  const data: BatchList | undefined = last && { ...last, batches: q.pages!.flatMap((p) => p.batches) };
  return { data, error: q.error, loading: q.loading || q.loadingMore, loadMore: q.loadMore };
}

const gh = (path: string) => `https://github.com/${path}`;
const extLink = "text-accent-ink hover:underline";

function Batches({ repo, phone }: { repo: string | undefined; phone: boolean }) {
  const { data, error, loading, loadMore } = usePagedBatches(repo);
  // Per-batch choice made by the person; batches without one follow their state: in flight are open, finished are folded.
  const [chosen, setChosen] = useState<Record<number, boolean>>({});
  useEffect(() => setChosen({}), [repo]);
  if (!data && !error) return null;
  if (data && data.batches.length === 0) return null;
  const batches = data?.batches ?? [];
  const isOpen = (b: QueueBatch) => chosen[b.id] ?? (b.state === "checking" || b.state === "open");
  const toggle = (b: QueueBatch) => setChosen((c) => ({ ...c, [b.id]: !isOpen(b) }));
  const setAll = (open: boolean) => setChosen(Object.fromEntries(batches.map((b) => [b.id, open])));
  const anyOpen = batches.some(isOpen);
  return (
    <Block
      className="mt-3"
      flush
      title="Integration batches"
      aside={
        <span className="flex items-center gap-3">
          {data && <span className="num">{num(data.total)}</span>}
          <button type="button" className="chip max-md:h-11" onClick={() => setAll(!anyOpen)} aria-label={anyOpen ? "Fold all batches" : "Unfold all batches"}>
            {anyOpen ? <ChevronsDownUpIcon className="size-3.5" /> : <ChevronsUpDownIcon className="size-3.5" />}
            {anyOpen ? "Fold all" : "Unfold all"}
          </button>
        </span>
      }
    >
      <ErrorLine error={error?.message} className="p-4" />
      {batches.length > 0 && (phone ? <BatchCards batches={batches} isOpen={isOpen} toggle={toggle} /> : <BatchTable batches={batches} isOpen={isOpen} toggle={toggle} />)}
      {data?.next && (
        <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-2.5 text-xs text-ink/55">
          <span className="num">
            {num(batches.length)} of {num(data.total)}
          </span>
          <button className="chip max-md:h-11" disabled={loading} onClick={loadMore}>
            {loading ? "Loading…" : "Show more"}
          </button>
        </div>
      )}
    </Block>
  );
}

type BatchProps = { batches: QueueBatch[]; isOpen: (b: QueueBatch) => boolean; toggle: (b: QueueBatch) => void };

/** The batch's facts in one run: used by the table header row and the phone card. */
function BatchFacts({ b }: { b: QueueBatch }) {
  useNow();
  const stop = { onClick: (e: React.MouseEvent) => e.stopPropagation() };
  const branch = b.fork ? (
    <a href={gh(`${b.fork}/tree/${b.branch}`)} target="_blank" rel="noopener noreferrer" title="Open the branch on GitHub" className={cn("font-mono text-xs [overflow-wrap:anywhere]", extLink)} {...stop}>
      {b.branch}
    </a>
  ) : (
    <span className="font-mono text-xs text-ink/70 [overflow-wrap:anywhere]">{b.branch}</span>
  );
  return (
    <>
      <Badge tone={BATCH_STATE[b.state][1]}>{BATCH_STATE[b.state][0]}</Badge>
      {branch}
      <span className="text-xs text-ink/60">{b.repo}</span>
      <span className="num text-xs text-ink/60">
        {b.size} PR{b.size === 1 ? "" : "s"}
      </span>
      {b.prUrl && (
        <a href={b.prUrl} target="_blank" rel="noopener noreferrer" title="Open the batch PR on GitHub" className={cn("code text-xs", extLink)} {...stop}>
          #{b.prNumber}
        </a>
      )}
      <a href={gh(`storytold/${b.repo}/commit/${b.baseSha}`)} target="_blank" rel="noopener noreferrer" title="Base commit on GitHub" className={cn("code text-xs", extLink)} {...stop}>
        {b.baseSha.slice(0, 7)}
      </a>
      <span className="num text-2xs text-ink/50" title={`created ${b.createdAt.slice(0, 16).replace("T", " ")}, updated ${b.updatedAt.slice(0, 16).replace("T", " ")}`}>
        {ago(b.updatedAt)} ago
      </span>
    </>
  );
}

function FoldChevron({ open }: { open: boolean }) {
  return <ChevronRightIcon className={cn("size-4 shrink-0 text-ink/45 transition-transform", open && "rotate-90")} />;
}

function BatchTable({ batches, isOpen, toggle }: BatchProps) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[960px] table-fixed border-collapse text-sm">
        <PrTableHead />
        {batches.map((b) => {
          const open = isOpen(b);
          return (
            <tbody key={b.id} className="border-b border-line last:border-0">
              <tr className="cursor-pointer bg-ink/[0.03] hover:bg-ink/[0.06]" onClick={() => toggle(b)}>
                <td colSpan={9} className="px-3 py-2">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <button type="button" aria-expanded={open} aria-label={open ? `Fold ${b.branch}` : `Unfold ${b.branch}`} className="shrink-0">
                      <FoldChevron open={open} />
                    </button>
                    <BatchFacts b={b} />
                    {b.summary && (
                      <span className="min-w-[12rem] flex-1 truncate text-2xs text-ink/55" title={b.summary}>
                        {b.summary}
                      </span>
                    )}
                  </div>
                </td>
              </tr>
              {open && b.prs.map((r) => <PrRows key={r.number} r={r} />)}
            </tbody>
          );
        })}
      </table>
    </div>
  );
}

function BatchCards({ batches, isOpen, toggle }: BatchProps) {
  return (
    <ul>
      {batches.map((b) => {
        const open = isOpen(b);
        return (
          <li key={b.id} className="border-b border-line last:border-0">
            <div role="button" tabIndex={0} aria-expanded={open} onClick={() => toggle(b)} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), toggle(b))} className="flex cursor-pointer items-start gap-2 bg-ink/[0.03] px-4 py-2.5 active:bg-ink/[0.06]">
              <span className="mt-0.5 flex h-6 items-center">
                <FoldChevron open={open} />
              </span>
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2.5 gap-y-1">
                <BatchFacts b={b} />
                {b.summary && <p className={cn("w-full text-2xs text-ink/55", !open && "line-clamp-1")}>{b.summary}</p>}
              </div>
            </div>
            {open && b.prs.length > 0 && (
              <ul className="border-t border-line">
                {b.prs.map((r) => (
                  <PrCard key={r.number} r={r} />
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function StateChip({ row }: { row: QueueRow }) {
  const [text, tone, hint] = STATE[row.state];
  const title = row.state === "refused" && row.refusedReason ? row.refusedReason : row.state === "declined" && row.answer ? `The operator answered ${row.answer}` : hint;
  return (
    <span title={title}>
      <Badge tone={tone}>{text}</Badge>
    </span>
  );
}

function DecisionLink({ row }: { row: QueueRow }) {
  if (!row.decisionId) return row.state === "needs-decision" ? <span className="text-2xs text-ink/45">asked on the next run</span> : <span className="text-ink/30">–</span>;
  return (
    <Link to={`/decisions/${encodeURIComponent(row.decisionId)}`} className="text-xs text-accent-ink hover:underline">
      {row.answer ? `Answered ${row.answer}` : "Open decision"}
    </Link>
  );
}

/** Why it waits, in one line: refusal reason, or what keeps it outside the rule. */
function Why({ row }: { row: QueueRow }) {
  if (row.state === "refused" && row.refusedReason) return <span className="text-2xs text-bad">{row.refusedReason}</span>;
  if (row.outsideRule.length) return <span className="text-2xs text-ink/50">outside the rule: {row.outsideRule.join(", ")}</span>;
  return null;
}

const V_TONE: Record<string, Tone> = { unavailable: "warn", passed: "ok", "ci-enough": "ok", failed: "bad", error: "warn", running: "accent", planned: "neutral", stale: "neutral" };
const V_LABEL: Record<string, string> = { unavailable: "Not verified", passed: "Passed", "ci-enough": "CI is enough", failed: "Failed", error: "Error", running: "Running", planned: "Planned", stale: "Stale" };

/** The Verify result at the reviewed head; the summary shows on hover and below the badge. */
function VerifyCell({ row, detail = true }: { row: QueueRow; detail?: boolean }) {
  const v = row.verify;
  if (!v) return <span className="text-ink/30">–</span>;
  const text = [v.summary, v.note].filter(Boolean).join(" · ");
  return (
    <span className="block" title={text || undefined}>
      <Badge tone={V_TONE[v.state] ?? "neutral"}>{V_LABEL[v.state] ?? v.state}</Badge>
      {detail && v.kind && <span className="ml-1.5 text-2xs text-ink/50">{v.kind}</span>}
      {detail && text && <span className="mt-0.5 line-clamp-2 block text-2xs text-ink/55">{text}</span>}
    </span>
  );
}

/** The review text, clamped to two lines; it opens and closes by click only when the text is longer than that. */
function ReviewText({ r }: { r: QueueRow }) {
  useNow();
  const [open, setOpen] = useState(false);
  const [clamped, setClamped] = useState(false);
  const ref = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      if (!open) setClamped(el.scrollHeight > el.clientHeight + 1);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open, r.reason, r.fixes]);
  const canToggle = clamped || open;
  return (
    <div className="flex items-start gap-1.5">
      {canToggle ? (
        <button type="button" aria-expanded={open} aria-label={open ? "Collapse the review" : "Expand the review"} onClick={() => setOpen(!open)} className="mt-0.5 shrink-0 text-ink/45 hover:text-ink">
          <ChevronRightIcon className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        </button>
      ) : (
        <span className="size-3.5 shrink-0" />
      )}
      <div className="min-w-0 flex-1 text-xs text-ink/65">
        <p ref={ref} className={cn(!open && "line-clamp-2", canToggle && "cursor-pointer")} onClick={canToggle ? () => setOpen(!open) : undefined}>
          {r.fixes > 0 && <span className="mr-1.5 text-ink/50">{r.fixes} fix{r.fixes === 1 ? "" : "es"}</span>}
          {r.reason}
        </p>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-2xs">
          <Why row={r} />
          <DecisionLink row={r} />
          <span className="num text-ink/40" title={`reviewed ${r.reviewedAt.slice(0, 16).replace("T", " ")} at ${r.head.slice(0, 7)}`}>
            reviewed {ago(r.reviewedAt)} ago
          </span>
        </div>
      </div>
    </div>
  );
}

/** Two rows per PR: the facts, then the review text. A fragment, so a table group can hold several. */
function PrRows({ r }: { r: QueueRow }) {
  const cell = "px-3 pt-2 align-top";
  return (
    <>
      <tr>
        <td className={cell}>
          <RefLink repo={r.repo} number={r.number} kind="pr" className="block text-xs" />
          <Link to={`/item/${r.repo}/${r.number}`} className="block font-medium [overflow-wrap:anywhere] hover:text-accent-ink hover:underline">
            {r.title}
          </Link>
        </td>
        <td className={cell}>
          <div className="truncate text-ink/75" title={`${r.author || "unknown"}, ${TIER[r.tier]}`}>
            {r.author || "unknown"}
            {r.tier === "whitelisted" && <span className="ml-1 text-2xs text-ok">●</span>}
          </div>
        </td>
        <td className={cn(cell, "num text-ink/70")}>{r.size}</td>
        <td className={cn(cell, "truncate text-xs text-ink/70")} title={r.label ?? undefined}>
          {r.label ?? <span className="text-ink/35">not settled</span>}
        </td>
        <td className={cell}>
          <Badge tone={r.verdict === "take" ? "ok" : "warn"}>{r.verdict}</Badge>
        </td>
        <td className={cell}>
          <Badge tone={CI_TONE[r.ci]}>{r.ci}</Badge>
        </td>
        <td className={cell}>
          <VerifyCell row={r} detail={false} />
        </td>
        <td className={cell}>
          <Badge tone={MERGEABLE[r.mergeable][1]}>{MERGEABLE[r.mergeable][0]}</Badge>
        </td>
        <td className={cell}>
          <StateChip row={r} />
        </td>
      </tr>
      <tr className="border-b border-line last:border-0">
        <td colSpan={9} className="px-3 pb-2 pt-0.5">
          <ReviewText r={r} />
        </td>
      </tr>
    </>
  );
}

function PrTableHead() {
  return (
    <>
      <colgroup>
        <col />
        <col className="w-[120px]" />
        <col className="w-[50px]" />
        <col className="w-[90px]" />
        <col className="w-[70px]" />
        <col className="w-[75px]" />
        <col className="w-[100px]" />
        <col className="w-[90px]" />
        <col className="w-[150px]" />
      </colgroup>
      <thead className="bg-ink/[0.03] text-xs text-ink/55">
        <tr className="border-b border-line text-left">
          <th className="h-8 px-3 font-medium">PR</th>
          <th className="px-3 font-medium">Author</th>
          <th className="px-3 font-medium">Size</th>
          <th className="px-3 font-medium">Label</th>
          <th className="px-3 font-medium">Verdict</th>
          <th className="px-3 font-medium">CI</th>
          <th className="px-3 font-medium">Verify</th>
          <th className="px-3 font-medium">Mergeable</th>
          <th className="px-3 font-medium">State</th>
        </tr>
      </thead>
    </>
  );
}

function Table({ rows }: { rows: QueueRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[960px] table-fixed border-collapse text-sm">
        <PrTableHead />
        {rows.map((r) => (
          <tbody key={`${r.repo}#${r.number}`} className="border-b border-line last:border-0 hover:bg-ink/[0.03]">
            <PrRows r={r} />
          </tbody>
        ))}
      </table>
    </div>
  );
}

function PrCard({ r }: { r: QueueRow }) {
  return (
    <li className="border-b border-line px-4 py-2.5 last:border-0">
      <div className="flex items-center gap-2 text-xs text-ink/55">
        <RefLink repo={r.repo} number={r.number} kind="pr" className="text-xs" />
        <span className="truncate">
          {r.author || "unknown"} · {TIER[r.tier]}
        </span>
        <span className="ml-auto shrink-0">
          <StateChip row={r} />
        </span>
      </div>
      <Link to={`/item/${r.repo}/${r.number}`} className="mt-1 block text-sm font-medium leading-5 active:text-accent-ink">
        {r.title}
      </Link>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-2xs text-ink/60">
        <Badge tone={r.verdict === "take" ? "ok" : "warn"}>{r.verdict}</Badge>
        <span>size {r.size}</span>
        <span>{r.label ?? "not settled"}</span>
        <Badge tone={CI_TONE[r.ci]}>CI {r.ci}</Badge>
        <Badge tone={MERGEABLE[r.mergeable][1]}>{MERGEABLE[r.mergeable][0]}</Badge>
      </div>
      <p className="mt-1 text-xs text-ink/65">{r.reason}</p>
      {r.verify && (
        <div className="mt-1.5">
          <VerifyCell row={r} />
        </div>
      )}
      <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
        <Why row={r} />
        {r.decisionId && (
          <Link to={`/decisions/${encodeURIComponent(r.decisionId)}`} className="inline-flex h-11 items-center text-xs text-accent-ink">
            {r.answer ? `Answered ${r.answer}` : "Open decision"}
          </Link>
        )}
      </div>
    </li>
  );
}

function Cards({ rows }: { rows: QueueRow[] }) {
  return (
    <ul>
      {rows.map((r) => (
        <PrCard key={`${r.repo}#${r.number}`} r={r} />
      ))}
    </ul>
  );
}

export const queueModule: FeatureModule = {
  id: "queue",
  permission: "viewer",
  nav: { label: "Merge queue", icon: GitMergeIcon, to: "/queue", group: "work", order: 0.5 },
  commands: [{ id: "go-queue", keys: "g q", label: "Go to merge queue", group: "Go to" }],
  routes: [{ path: "queue", view: { id: "queue", title: "Merge queue", panels: [{ id: "main", title: "Merge queue", component: QueueView, defaultSize: 100 }] } }],
};
