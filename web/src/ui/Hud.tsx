import type { ReactNode } from "react";
import { cn } from "./cn";

/** ArtCraft's .hud-label: the mono uppercase micro-label used for section titles and field names. */
export function Hud({ children, className, as: As = "span" }: { children: ReactNode; className?: string; as?: "span" | "h2" | "h3" | "div" | "dt" }) {
  return <As className={cn("hud text-ink/55", className)}>{children}</As>;
}

/** Corner registration marks, as on ArtCraft's landing sections. Parent must be `relative`. */
export function RegMarks() {
  return (
    <>
      <span aria-hidden className="reg -left-[6px] -top-[6px]" />
      <span aria-hidden className="reg -right-[6px] -top-[6px]" />
      <span aria-hidden className="reg -bottom-[6px] -left-[6px]" />
      <span aria-hidden className="reg -bottom-[6px] -right-[6px]" />
    </>
  );
}
