import { CheckCircleIcon, CircleIcon, GitMergeIcon, GitPullRequestIcon, RadioButtonIcon, ShieldWarningIcon, type Icon as PhosphorIcon } from "@phosphor-icons/react";
import type { ItemKind, ItemState } from "../../api/types";
import { cn } from "../cn";
import { Tooltip } from "./Tooltip";

/** An item's kind, or a security finding (a row that is not a GitHub item). */
export type IconKind = ItemKind | "finding";

/** Phosphor icon, colour and name for an item, as GitHub shows its state. */
function look(kind: IconKind | null | undefined, state: ItemState | null | undefined, draft: boolean | undefined): [PhosphorIcon, string, string] {
  if (kind === "pr") {
    if (state === "merged") return [GitMergeIcon, "text-merged", "Merged pull request"];
    if (state === "closed") return [GitPullRequestIcon, "text-bad", "Closed pull request"];
    return draft ? [GitPullRequestIcon, "text-ink/60", "Draft pull request"] : [GitPullRequestIcon, "text-ok", "Open pull request"];
  }
  if (kind === "issue") return state === "closed" ? [CheckCircleIcon, "text-merged", "Closed issue"] : [RadioButtonIcon, "text-ok", "Open issue"];
  if (kind === "finding") return [ShieldWarningIcon, "text-warn", "Security finding"];
  return [CircleIcon, "text-ink/45", "Item"];
}

/** The item's kind and state as a plain icon, named in its tip, as tall as one text line (`1lh`) so it sits with the text, also on wrapped titles. */
export function ItemIcon({ kind, state, draft, className, tip = true }: { kind?: IconKind | null; state?: ItemState | null; draft?: boolean; className?: string; /** false leaves out the tip (inside another tip). */ tip?: boolean }) {
  const [Icon, tone, what] = look(kind, state, draft);
  return (
    <Tooltip title={tip ? what : undefined} align="start">
      <span role="img" aria-label={what} className={cn("inline-flex h-[1lh] shrink-0 items-center", tone, className)}>
        <Icon aria-hidden size="1.2em" weight="bold" />
      </span>
    </Tooltip>
  );
}
