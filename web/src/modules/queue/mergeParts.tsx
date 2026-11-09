// Parts of the Merge tab: PR rows with CI, Verify and batch columns, and the batch header facts.
import { useIsLinked } from "./highlight";
import { useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { CaretRightIcon } from "@phosphor-icons/react";
import type { BatchState, QueueBatch, QueueMergeRow, QueueRow, QueueState, Tier } from "../../api/types";
import { Badge, type Tone } from "../../ui/atoms/Badge";
import { ItemRef } from "../../ui/molecules/ItemRef";
import { PrBuildLine } from "../../ui/molecules/PrBuildLine";
import { cn } from "../../ui/cn";
import { when } from "../../lib/format";
import { TimeAgo } from "../../ui/atoms/TimeAgo";
import { useNow } from "../../lib/useNow";
import { batchPath, decisionPath, repoSlug } from "../../lib/links";
import { FastMark } from "./fastTrack";
import { RowMenu } from "./RowMenu";

export const STATE: Record<QueueState, [string, Tone, string]> = {
  ready: ["Ready", "ok", "Covered by the merge rule; merges on the next run"],
  "decision-answered-merge": ["Merge approved", "ok", "The operator answered merge at this head; merges on the next run"],
  refused: ["Refused", "bad", "The merge command or a pre-merge check said no; tried again next run"],
  "waiting-ci": ["Waiting for CI", "neutral", "CI is pending or hasn't run, or GitHub is still checking mergeability"],
  "waiting-main-ci": ["Waiting: main CI red", "neutral", "The repo's default branch fails CI; ready PRs wait until main is green"],
  "ci-failed": ["CI failed", "bad", "CI fails at this head"],
  conflict: ["Conflict", "bad", "Conflicts with the base branch"],
  "needs-fix-up": ["Needs fix-up", "warn", "The review lists small fixes; a later step makes them"],
  "waiting-premerge": ["Waiting for the pre-merge review", "neutral", "The merge rule covers it; an adversarial review of the head commit runs before it merges"],
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
  "ci-approval": ["CI: waiting for run approval", "warn", "GitHub holds the workflow runs for a maintainer's approval; the pipeline approves them when the repo allows it"],
  "changes-requested": ["Changes requested", "bad", "A maintainer's changes-requested review stands; it waits for that reviewer to approve or for a maintainer to dismiss it"],
};
export const TIER: Record<Tier, string> = { whitelisted: "whitelisted", not: "not whitelisted", "override-allow": "override allow", "override-deny": "override deny" };
const CI_TONE: Record<QueueRow["ci"], Tone> = { success: "ok", failure: "bad", pending: "warn", none: "neutral", unknown: "neutral" };
const MERGEABLE: Record<QueueRow["mergeable"], [string, Tone]> = { clean: ["clean", "ok"], conflicts: ["conflicts", "bad"], unknown: ["unknown", "neutral"] };

export const gh = (path: string) => `https://github.com/${path}`;
export const extLink = "text-accent-ink hover:underline";

export const BATCH_STATE: Record<BatchState, [string, Tone]> = {
  checking: ["Checking", "neutral"], open: ["PR open", "ok"], merged: ["Merged", "merged"], failed: ["Failed", "bad"], split: ["Split", "warn"], superseded: ["Rebuilt", "neutral"],
};

/** The batch's facts in one run: used by the table header row and the phone card. */
export function BatchFacts({ b }: { b: QueueBatch }) {
  useNow();
  const branch = b.fork ? (
    <a href={gh(`${b.fork}/tree/${b.branch}`)} target="_blank" rel="noopener noreferrer" title="Open the branch on GitHub" className={cn("font-mono text-xs [overflow-wrap:anywhere]", extLink)}>
      {b.branch}
    </a>
  ) : (
    <span className="font-mono text-xs text-ink/70 [overflow-wrap:anywhere]">{b.branch}</span>
  );
  return (
    <>
      <Link to={batchPath(b.id)} title="Open the batch" className="relative z-10 inline-flex">
        <Badge tone={BATCH_STATE[b.state][1]}>{BATCH_STATE[b.state][0]}</Badge>
      </Link>
      <Link to={batchPath(b.id)} className="relative z-10 text-xs font-medium text-accent-ink hover:underline">
        Batch #{b.id}
      </Link>
      {branch}
      <span className="text-xs text-ink/60">{b.repo}</span>
      <span className="num text-xs text-ink/60">
        {b.size} PR{b.size === 1 ? "" : "s"}
      </span>
      {b.prNumber !== null && <ItemRef repo={b.repo} number={b.prNumber} kind="pr" state={b.state === "merged" ? "merged" : b.state === "open" || b.state === "checking" ? "open" : "closed"} title={null} size="sm" className="flex-none" />}
      <a href={gh(`${repoSlug(b.repo)}/commit/${b.baseSha}`)} target="_blank" rel="noopener noreferrer" title="Base commit on GitHub" className={cn("code text-xs", extLink)}>
        {b.baseSha.slice(0, 7)}
      </a>
      <span className="num text-2xs text-ink/50" title={`created ${when(b.createdAt)}, updated ${when(b.updatedAt)}`}>
        <TimeAgo iso={b.updatedAt} />
      </span>
    </>
  );
}

function MergeMenu({ r, inBatch }: { r: QueueMergeRow; inBatch?: boolean }) {
  return <RowMenu repo={r.repo} number={r.number} fast={r.fast} held={r.held} pr inBatch={inBatch} />;
}

export function StateChip({ row }: { row: QueueRow }) {
  const [text, tone, hint] = STATE[row.state];
  const title = row.state === "refused" && row.refusedReason ? row.refusedReason : row.state === "declined" && row.answer ? `The operator answered ${row.answer}` : hint;
  return (
    <span title={title} className="relative z-10">
      <Badge tone={tone}>{text}</Badge>
      {row.conflictNote && <span className="ml-1.5 text-2xs text-ink/55">{row.conflictNote}</span>}
    </span>
  );
}

function DecisionLink({ row }: { row: QueueRow }) {
  if (!row.decisionId) return row.state === "needs-decision" ? <span className="text-2xs text-ink/45">asked on the next run</span> : <span className="text-ink/30">–</span>;
  return (
    <Link to={decisionPath({ id: row.decisionId, repo: row.repo, number: row.number })} className="relative z-10 text-xs text-accent-ink hover:underline">
      {row.answer ? `Answered ${row.answer}` : "Open decision"}
    </Link>
  );
}

/** Why it waits, in one line: refusal reason, or what keeps it outside the rule. */
function Why({ row }: { row: QueueRow }) {
  if (row.state === "refused" && row.refusedReason) return <span className="text-2xs text-bad">{row.refusedReason}</span>;
  if (row.note) return <span className="text-2xs text-bad">{row.note}</span>;
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
    <span className="relative z-10 block" title={text || undefined}>
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
        <button type="button" aria-expanded={open} aria-label={open ? "Collapse the review" : "Expand the review"} onClick={() => setOpen(!open)} className="relative z-10 mt-0.5 shrink-0 text-ink/45 hover:text-ink">
          <CaretRightIcon className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        </button>
      ) : (
        <span className="size-3.5 shrink-0" />
      )}
      <div className="min-w-0 flex-1 text-xs text-ink/65">
        <p ref={ref} className={cn(!open && "line-clamp-2", canToggle && "relative z-10 cursor-pointer")} onClick={canToggle ? () => setOpen(!open) : undefined}>
          {r.fixes > 0 && <span className="mr-1.5 text-ink/50">{r.fixes} fix{r.fixes === 1 ? "" : "es"}</span>}
          {r.reason}
        </p>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-2xs">
          <Why row={r} />
          <DecisionLink row={r} />
          <span className="num text-ink/40" title={`reviewed ${when(r.reviewedAt)} at ${r.head.slice(0, 7)}`}>
            reviewed <TimeAgo iso={r.reviewedAt} />
          </span>
        </div>
      </div>
    </div>
  );
}

/** Two rows per PR: the facts, then the review text. A fragment, so a table group can hold several. */
export function PrRows({ r, inBatch }: { r: QueueMergeRow; inBatch?: boolean }) {
  const cell = "px-3 pt-2 align-top";
  const linked = useIsLinked(r.repo, r.number);
  return (
    <>
      <tr data-item={`${r.repo}:${r.number}`} className={cn("relative", linked && "bg-accent/10")}>
        <td className={cell}>
          <div className="flex items-start gap-1">
            <FastMark fast={r.fast} />
            <ItemRef repo={r.repo} number={r.number} kind="pr" state="open" title={r.title} stretch />
          </div>
        </td>
        <td className={cell}>
          <div className="relative z-10 truncate text-ink/75" title={`${r.author || "unknown"}, ${TIER[r.tier]}`}>
            {r.author || "unknown"}
            {r.tier === "whitelisted" && <span className="ml-1 text-2xs text-ok">●</span>}
          </div>
        </td>
        <td className={cn(cell, "num text-ink/70")}>{r.size}</td>
        <td className={cn(cell, "truncate text-xs text-ink/70")}>
          <span className="relative z-10" title={r.label ?? undefined}>{r.label ?? <span className="text-ink/35">not settled</span>}</span>
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
          <div className="flex items-start justify-between gap-1">
            <div className="flex flex-col items-start gap-1">
              <StateChip row={r} />
              {r.held && <Badge tone="warn">Held</Badge>}
            </div>
            <MergeMenu r={r} inBatch={inBatch} />
          </div>
        </td>
      </tr>
      <tr className="border-b border-line last:border-0">
        <td colSpan={9} className="px-3 pb-2 pt-0.5">
          <ReviewText r={r} />
          <PrBuildLine b={r.prBuild} className="ml-5 mt-1" />
        </td>
      </tr>
    </>
  );
}

export function PrTableHead() {
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
        <col className="w-[180px]" />
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

export function Table({ rows }: { rows: QueueMergeRow[] }) {
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

export function PrCard({ r, inBatch }: { r: QueueMergeRow; inBatch?: boolean }) {
  const linked = useIsLinked(r.repo, r.number);
  return (
    <li data-item={`${r.repo}:${r.number}`} className={cn("relative border-b border-line px-4 py-2.5 last:border-0", linked && "bg-accent/10")}>
      <div className="flex items-start gap-2 text-xs text-ink/55">
        <FastMark fast={r.fast} />
        <ItemRef repo={r.repo} number={r.number} kind="pr" state="open" title={r.title} stretch className="flex-1" />
        <span className="flex shrink-0 items-center gap-1.5">
          <StateChip row={r} />
          {r.held && <Badge tone="warn">Held</Badge>}
          <MergeMenu r={r} inBatch={inBatch} />
        </span>
      </div>
      <div className="mt-1 text-xs text-ink/55">
        {r.author || "unknown"} · {TIER[r.tier]}
      </div>
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
      <PrBuildLine b={r.prBuild} className="mt-1.5" />
      <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
        <Why row={r} />
        {r.decisionId && (
          <Link to={decisionPath({ id: r.decisionId, repo: r.repo, number: r.number })} className="relative z-10 inline-flex h-11 items-center text-xs text-accent-ink">
            {r.answer ? `Answered ${r.answer}` : "Open decision"}
          </Link>
        )}
      </div>
    </li>
  );
}

export function Cards({ rows }: { rows: QueueMergeRow[] }) {
  return (
    <ul>
      {rows.map((r) => (
        <PrCard key={`${r.repo}#${r.number}`} r={r} />
      ))}
    </ul>
  );
}

