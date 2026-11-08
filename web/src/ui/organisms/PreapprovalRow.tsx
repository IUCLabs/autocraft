import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import { GitMergeIcon, HourglassIcon, ProhibitIcon, QuestionIcon, SpinnerIcon, WarningCircleIcon } from "@phosphor-icons/react";
import type { Preapproval } from "../../api/types";
import { githubCommitUrl } from "../../lib/links";
import { Button } from "../atoms/Button";
import { TimeAgo } from "../atoms/TimeAgo";
import { ConfirmButton } from "../molecules/ConfirmButton";
import { cn } from "../cn";

const STATE: Record<Preapproval["state"], { label: string; icon: PhosphorIcon; spin?: boolean; tone: string }> = {
  fixup: { label: "Fix-up running, then merge", icon: SpinnerIcon, spin: true, tone: "text-ink/50" },
  review: { label: "Fix-up pushed, waiting for the review", icon: SpinnerIcon, spin: true, tone: "text-ink/50" },
  ci: { label: "Review says take, waiting for CI", icon: HourglassIcon, tone: "text-ink/50" },
  queued: { label: "In the merge queue", icon: GitMergeIcon, tone: "text-accent-ink" },
  merged: { label: "Merged", icon: GitMergeIcon, tone: "text-merged" },
  asked: { label: "Stopped, a question was asked", icon: QuestionIcon, tone: "text-warn" },
  cancelled: { label: "Cancelled", icon: ProhibitIcon, tone: "text-ink/50" },
  failed: { label: "Fix-up failed", icon: WarningCircleIcon, tone: "text-bad" },
};
const ACTIVE = new Set<Preapproval["state"]>(["fixup", "review", "ci", "queued"]);

function Head({ repo, number, sha }: { repo: string; number: number; sha: string }) {
  return (
    <a href={githubCommitUrl(repo, number, sha)} target="_blank" rel="noopener noreferrer" title="Open the commit on GitHub" className="code text-accent-ink hover:underline">
      {sha.slice(0, 7)}
    </a>
  );
}

/** The pre-approved merge of a PR: its state in plain words, the operator's instructions, the heads and the reason it ended. Props only. */
export function PreapprovalRow({ p, repo, number, canCancel, onCancel, canRetry = false, onRetry, loading, className }: {
  p: Preapproval;
  repo: string;
  number: number;
  canCancel: boolean;
  onCancel: () => void;
  /** Operators: queue a failed pre-approval again with the same instructions. */
  canRetry?: boolean;
  onRetry?: () => void;
  loading?: boolean;
  className?: string;
}) {
  const s = STATE[p.state];
  const Icon = s.icon;
  return (
    <section aria-label="Fix-up, then merge" className={cn("rounded-md border border-line-strong bg-raised px-3 py-2.5", className)}>
      <div className="flex items-start gap-2">
        <Icon className={cn("mt-[3px] shrink-0", s.tone, s.spin && "animate-spin")} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium leading-5">{s.label}</p>
          <p className="text-xs text-ink/55">
            {p.by} · <TimeAgo iso={p.at} />
          </p>
        </div>
        {canCancel && ACTIVE.has(p.state) && <ConfirmButton label="Cancel" confirmLabel="Confirm cancel" idle="secondary" loading={loading} onConfirm={onCancel} />}
        {canRetry && p.state === "failed" && onRetry && <Button size="sm" variant="secondary" loading={loading} className="max-md:h-11" onClick={onRetry}>Try again</Button>}
      </div>
      {p.instructions && <blockquote className="mt-2 whitespace-pre-wrap break-words border-l-2 border-line-strong pl-3 text-sm leading-5 text-ink/75">{p.instructions}</blockquote>}
      <p className="mt-2 text-xs text-ink/60">
        <Head repo={repo} number={number} sha={p.fromHead} />
        {p.head && (
          <>
            {" → "}
            <Head repo={repo} number={number} sha={p.head} />
          </>
        )}
      </p>
      {p.reason && <p className="mt-1 text-xs text-ink/70">{p.reason}</p>}
    </section>
  );
}
