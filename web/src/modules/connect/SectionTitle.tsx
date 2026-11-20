import type { Icon } from "@phosphor-icons/react";
import type { ReactNode } from "react";

/** A Connect page block title: the section's icon, then its name. */
export function SectionTitle({ icon: I, children }: { icon: Icon; children: ReactNode }) {
  return (
    <span className="flex items-center gap-2">
      <I className="shrink-0 text-ink/60" />
      {children}
    </span>
  );
}
