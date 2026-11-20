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

/** A small header button's hit area, grown to 44 px on phones without making the header taller. */
export const touch = "relative max-md:after:absolute max-md:after:inset-x-0 max-md:after:-inset-y-2";
