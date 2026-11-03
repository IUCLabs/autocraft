import { Link } from "react-router-dom";
import type { ItemKind, ItemState } from "../../api/types";
import { itemPath } from "../../lib/links";
import { cn } from "../cn";
import { ItemIcon } from "../atoms/ItemIcon";

/**
 * An item as `[icon] repo#num full title`. The icon opens the item on GitHub; the text opens the item page (or `href`).
 * The title wraps. With `stretch` the text link covers the nearest positioned ancestor, so the whole row or card
 * is the click target: that container must be `relative`, and other controls in it need `relative z-10`.
 */
export function ItemRef({ repo, number, kind, state, draft, title, href, stretch, size = "md", className }: {
  repo: string;
  number: number;
  kind?: ItemKind | null;
  state?: ItemState | null;
  draft?: boolean;
  /** null while the data lacks it: only `repo#num` shows */
  title: string | null | undefined;
  href?: string;
  stretch?: boolean;
  size?: "sm" | "md";
  className?: string;
}) {
  return (
    <span className={cn("flex min-w-0 items-start gap-2", size === "sm" ? "text-xs" : "text-sm", className)}>
      <ItemIcon repo={repo} number={number} kind={kind} state={state} draft={draft} className="mt-0.5" />
      <Link to={href ?? itemPath(repo, number)} className={cn("min-w-0 break-words [overflow-wrap:anywhere] hover:underline", stretch && "after:absolute after:inset-0")}>
        <span className="code text-ink/60">
          {repo}#{number}
        </span>
        {title ? <span className="text-ink"> {title}</span> : null}
      </Link>
    </span>
  );
}
