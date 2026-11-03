// "Similar items" on the Item page: the nearest items by embedding across the
// tracked repos, open and closed, for spotting duplicates.
import { Link } from "react-router-dom";
import { RadioButtonIcon, ProhibitIcon, GitMergeIcon, GitPullRequestIcon } from "@phosphor-icons/react";
import { useQuery } from "../../api/client";
import type { SimilarHit } from "../../api/types";
import type { FeatureModule, ViewProps } from "../../registry/types";
import { Badge } from "../../ui/Badge";
import { Count } from "../../ui/Heading";
import { RefLink } from "../../ui/RefLink";
import { cn } from "../../ui/cn";

const REASON: Record<NonNullable<SimilarHit["stateReason"]>, string> = { duplicate: "closed as duplicate", "not-planned": "closed, not planned", completed: "closed, completed" };

export function StateIcon({ h }: { h: Pick<SimilarHit, "kind" | "state"> }) {
  if (h.state === "merged") return <GitMergeIcon className="text-xs text-merged" aria-label="merged" />;
  if (h.state === "closed") return <ProhibitIcon className="text-xs text-ink/45" aria-label="closed" />;
  return h.kind === "pr" ? <GitPullRequestIcon className="text-xs text-ok" aria-label="open PR" /> : <RadioButtonIcon className="text-xs text-ok" aria-label="open issue" />;
}

/** Cosine similarity as shown: two decimals, strong matches highlighted. */
export function Score({ score, className }: { score: number; className?: string }) {
  return (
    <span className={cn("num text-xs", score >= 0.9 ? "font-semibold text-warn" : score >= 0.8 ? "text-ink/75" : "text-ink/45", className)} title="Similarity (cosine, 1 = same text)">
      {score.toFixed(2)}
    </span>
  );
}

function SimilarItems({ params }: ViewProps) {
  const repo = params.repo!;
  const n = Number(params.number);
  const { data, error } = useQuery(`similar:${repo}#${n}`, (api) => api.similar(repo, n, 10));
  return (
    <section className="border-b border-line px-4 py-3">
      <h2 className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-ink/60">
        Similar items <Count n={data?.length} />
      </h2>
      {error && <p className="text-sm text-ink/50">{error.message}</p>}
      {!data && !error && <p className="text-sm text-ink/50">Loading…</p>}
      {data?.length === 0 && <p className="text-sm text-ink/50">None found.</p>}
      <ul className="space-y-2">
        {data?.map((h) => {
          const closed = h.state !== "open";
          return (
            <li key={`${h.repo}#${h.number}`} className="text-sm">
              <div className="flex items-center gap-1.5 text-xs">
                <StateIcon h={h} />
                <RefLink repo={h.repo} number={h.number} kind={h.kind} className="text-xs" />
                {h.label && <Badge className="ml-0.5">{h.label}</Badge>}
                <Score score={h.score} className="ml-auto" />
              </div>
              <Link to={`/item/${h.repo}/${h.number}`} className={cn("mt-0.5 block leading-5 hover:underline", closed && "text-ink/55")}>
                {h.title}
              </Link>
              {closed && (
                <div className={cn("text-xs", h.stateReason === "duplicate" ? "text-warn" : "text-ink/45")}>
                  {h.state === "merged" ? "merged" : h.stateReason ? REASON[h.stateReason] : "closed"}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export const similarModule: FeatureModule = {
  id: "similar",
  permission: "viewer",
  routes: [],
  commands: [{ id: "search-semantic", keys: "alt+m", label: "Search by meaning (in the search box)", group: "Anywhere" }],
  slots: [{ slot: "item.side", order: 10, component: SimilarItems }],
};
