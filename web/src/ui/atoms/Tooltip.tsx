// The app's tooltip, in place of the browser's `title`: it opens at once (the provider in main.tsx has no delay), takes any content, so
// a tip can carry a heading, a state and a few lines of detail, and stays on screen at the edges. Keyboard focus opens it too.
// A tip is extra information: whatever it says must also be reachable without it (screen readers get the trigger's own text).
import type { ReactNode } from "react";
import { Tooltip as T } from "radix-ui";
import { cn } from "../cn";

export function Tooltip({ content, title, children, side = "top", align = "center", className }: {
  /** The body; plain text or any markup. Nothing to show leaves the trigger as it is. */
  content?: ReactNode;
  /** A bold first line. */
  title?: ReactNode;
  /** One element that takes a ref (a span, a button, a link). */
  children: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  className?: string;
}) {
  if ((content == null || content === "" || content === false) && title == null) return <>{children}</>;
  return (
    <T.Root>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content
          side={side}
          align={align}
          sideOffset={6}
          collisionPadding={8}
          className={cn("z-50 max-w-[320px] rounded-md border border-line-strong bg-raised px-2.5 py-1.5 text-xs leading-snug text-ink shadow-[0_8px_24px_rgba(0,0,0,0.25)]", className)}
        >
          {title != null && <div className="font-medium text-ink">{title}</div>}
          {content != null && content !== false && <div className={cn(title != null && "mt-0.5 text-ink/70")}>{content}</div>}
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}

/** Lines of detail in a tip, one per non-empty entry. */
export function TipLines({ lines }: { lines: (ReactNode | null | undefined | false)[] }) {
  const shown = lines.filter((l) => l != null && l !== false && l !== "");
  return (
    <>
      {shown.map((l, i) => (
        <div key={i} className="[overflow-wrap:anywhere]">
          {l}
        </div>
      ))}
    </>
  );
}
