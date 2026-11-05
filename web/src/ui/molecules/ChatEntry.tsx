import type { ReactNode } from "react";
import { Avatar } from "../atoms/Avatar";
import { TimeAgo } from "../atoms/TimeAgo";
import { cn } from "../cn";

/**
 * One message of the item thread: avatar, author and time on a header strip, the content below.
 * "ours" is AutoCraft's blue, used for Opus.
 */
export function ChatEntry({ id, author, at, tone = "person", tag, children, className }: {
  /** Event id, for the `#event=` deep link. */
  id?: string;
  author: string;
  at: string;
  tone?: "person" | "ours";
  /** A short label at the right of the header (Review, Opening post). */
  tag?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <li id={id ? `event-${id}` : undefined} className={cn("min-w-0 scroll-mt-3 list-none", className)}>
      <div className={cn("overflow-hidden rounded-md border", tone === "ours" ? "border-accent/40" : "border-line")}>
        <div className={cn("flex min-h-9 items-center gap-2 border-b px-3 py-1.5 text-sm", tone === "ours" ? "border-accent/30 bg-accent/[0.08]" : "border-line bg-ink/[0.03]")}>
          <Avatar login={author} size={20} />
          <span className={cn("min-w-0 truncate font-semibold", tone === "ours" && "text-accent-ink")}>{author}</span>
          <TimeAgo iso={at} className="num shrink-0 text-xs text-ink/55" />
          {tag && <span className="ml-auto shrink-0 text-xs text-ink/55">{tag}</span>}
        </div>
        <div className="min-w-0 px-3 py-2.5 text-sm leading-5 text-ink/85">{children}</div>
      </div>
    </li>
  );
}
