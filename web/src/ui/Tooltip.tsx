import type { ReactNode } from "react";
import { Tooltip as T } from "radix-ui";

export function Tooltip({ label, children, side = "top" }: { label: ReactNode; children: ReactNode; side?: "top" | "right" | "bottom" | "left" }) {
  return (
    <T.Root>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content side={side} sideOffset={6} className="z-50 border border-line bg-raised px-2 py-1 font-mono text-2xs uppercase tracking-[0.1em] text-ink shadow-[0_8px_24px_rgba(0,0,0,0.35)] animate-fadeIn">
          {label}
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}
