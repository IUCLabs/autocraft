import { CheckCircleIcon, CircleIcon, GitMergeIcon, GitPullRequestIcon, RadioButtonIcon, type Icon as PhosphorIcon } from "@phosphor-icons/react";
import type { ItemKind, ItemState } from "../../api/types";
import { cn } from "../cn";
import { Tooltip } from "./Tooltip";

/** Phosphor icon and colour for an item, as GitHub shows its state. */
function look(kind: ItemKind | null | undefined, state: ItemState | null | undefined, draft: boolean | undefined): [PhosphorIcon, string, string, string] {
  if (kind === "pr") {
    if (state === "merged") return [GitMergeIcon, "text-merged", "Merged pull request", "Its changes are in the base branch."];
    if (state === "closed") return [GitPullRequestIcon, "text-bad", "Closed pull request", "Closed without merging."];
    return draft
      ? [GitPullRequestIcon, "text-ink/60", "Draft pull request", "Open, but its author marked it as not ready for review."]
      : [GitPullRequestIcon, "text-ok", "Open pull request", "Proposed changes, not merged yet."];
  }
  if (kind === "issue")
    return state === "closed"
      ? [CheckCircleIcon, "text-merged", "Closed issue", "Fixed, answered or closed as not planned."]
      : [RadioButtonIcon, "text-ok", "Open issue", "A bug report or a request that is still open."];
  return [CircleIcon, "text-ink/45", "Item", "An issue or a pull request."];
}

/** The item's kind and state as a plain icon, named and explained in its tip, as tall as one text line (`1lh`) so it sits with the text, also on wrapped titles. */
export function ItemIcon({ kind, state, draft, className, tip = true }: { kind?: ItemKind | null; state?: ItemState | null; draft?: boolean; className?: string; /** false leaves out the tip (inside another tip). */ tip?: boolean }) {
  const [Icon, tone, what, explain] = look(kind, state, draft);
  return (
    <Tooltip title={tip ? what : undefined} content={tip ? explain : undefined} align="start">
      <span role="img" aria-label={what} className={cn("inline-flex h-[1lh] shrink-0 items-center", tone, className)}>
        <Icon aria-hidden size="1.2em" weight="bold" />
      </span>
    </Tooltip>
  );
}
