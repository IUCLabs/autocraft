// Adapted from ArtCraft libs/components/badge (MIT OR Apache-2.0): square, hairline,
// mono uppercase micro text. Tones added for state.
import type { ReactNode } from "react";
import { cn } from "./cn";

export type Tone = "neutral" | "ok" | "warn" | "bad" | "accent" | "solid";
const tones: Record<Tone, string> = {
  neutral: "border-line text-ink/70 bg-ink/[0.04]",
  ok: "border-ok/40 text-ok bg-ok/10",
  warn: "border-warn/45 text-warn bg-warn/10",
  bad: "border-bad/45 text-bad bg-bad/10",
  accent: "border-accent-ink/45 text-accent-ink bg-accent/10",
  solid: "border-ink bg-ink text-inv",
};

export function Badge({ children, tone = "neutral", icon, className }: { children: ReactNode; tone?: Tone; icon?: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-[18px] shrink-0 items-center gap-1 whitespace-nowrap rounded-none border px-1.5 font-mono text-2xs font-medium uppercase tracking-[0.1em]",
        tones[tone],
        className,
      )}
    >
      {icon}
      {children}
    </span>
  );
}
