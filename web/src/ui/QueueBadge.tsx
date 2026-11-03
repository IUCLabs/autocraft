import { useNavigate } from "react-router-dom";
import type { QueueSlot } from "../api/types";
import { cn } from "./cn";

/** `/queue/<tab>?item=<repo>:<number>`: the stage's Queue tab with the item scrolled into view and highlighted. */
export const queueItemPath = (slot: QueueSlot, repo: string, number: number): string => `/queue/${slot.tab}?item=${encodeURIComponent(`${repo}:${number}`)}`;

/** "Review #3": the item's place in line for its next stage. A button, so it also works inside a row that is a link. */
export function QueueBadge({ slot, repo, number, className }: { slot: QueueSlot | null | undefined; repo: string; number: number; className?: string }) {
  const navigate = useNavigate();
  if (!slot) return null;
  return (
    <button
      type="button"
      title={`Place ${slot.place} in line for ${slot.stage}`}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        navigate(queueItemPath(slot, repo, number));
      }}
      className={cn("inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-accent-ink/40 bg-accent/10 px-2 text-2xs font-medium text-accent-ink hover:bg-accent/20 max-md:h-7", className)}
    >
      {slot.stage} <span className="num">#{slot.place}</span>
    </button>
  );
}
