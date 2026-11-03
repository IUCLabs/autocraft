import { CheckCircleIcon, CircleIcon, GitMergeIcon, GitPullRequestIcon, RadioButtonIcon, type Icon as PhosphorIcon } from "@phosphor-icons/react";
import type { ItemKind, ItemState } from "../../api/types";
import { githubItemUrl } from "../../lib/links";
import { cn } from "../cn";

/** Phosphor icon and colour for an item, as GitHub shows its state. */
function look(kind: ItemKind | null | undefined, state: ItemState | null | undefined, draft: boolean | undefined): [PhosphorIcon, string, string] {
  if (kind === "pr") {
    if (state === "merged") return [GitMergeIcon, "text-merged", "merged PR"];
    if (state === "closed") return [GitPullRequestIcon, "text-bad", "closed PR"];
    return draft ? [GitPullRequestIcon, "text-ink/60", "draft PR"] : [GitPullRequestIcon, "text-ok", "open PR"];
  }
  if (kind === "issue") return state === "closed" ? [CheckCircleIcon, "text-merged", "closed issue"] : [RadioButtonIcon, "text-ok", "open issue"];
  return [CircleIcon, "text-ink/45", "item"];
}

/** The item's kind and state as a link that opens it on GitHub in a new tab. Inside a stretched row it needs `relative z-10`, which it sets itself. */
export function ItemIcon({ repo, number, kind, state, draft, className }: { repo: string; number: number; kind?: ItemKind | null; state?: ItemState | null; draft?: boolean; className?: string }) {
  const [Icon, tone, what] = look(kind, state, draft);
  return (
    <a
      href={githubItemUrl(repo, number, kind)}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Open ${repo}#${number} on GitHub`}
      title={`${what[0]!.toUpperCase()}${what.slice(1)}: open on GitHub`}
      className={cn("relative z-10 -m-1.5 inline-flex shrink-0 rounded p-1.5 hover:bg-ink/10 [@media(pointer:coarse)]:-m-2.5 [@media(pointer:coarse)]:p-2.5", tone, className)}
    >
      <Icon aria-hidden size="1.2em" weight="bold" />
    </a>
  );
}
