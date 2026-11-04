// Labels, icons and grouping for the item trace.
import {
  ChatsIcon,
  GearIcon,
  GithubLogoIcon,
  ListChecksIcon,
  MagnifyingGlassIcon,
  PencilSimpleIcon,
  QuestionIcon,
  ShieldCheckIcon,
  SparkleIcon,
  WrenchIcon,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import type { TraceEvent, TraceKind } from "../api/types";

export const TRACE_KIND: Record<TraceKind, { label: string; Icon: PhosphorIcon }> = {
  "model-call": { label: "Model calls", Icon: SparkleIcon },
  github: { label: "GitHub", Icon: GithubLogoIcon },
  decision: { label: "Decisions", Icon: QuestionIcon },
  write: { label: "Writes", Icon: PencilSimpleIcon },
  check: { label: "Checks", Icon: ShieldCheckIcon },
  review: { label: "Reviews", Icon: MagnifyingGlassIcon },
  plan: { label: "Plan", Icon: ListChecksIcon },
  job: { label: "Jobs", Icon: GearIcon },
  step: { label: "Fixes and merges", Icon: WrenchIcon },
  conversation: { label: "Conversation", Icon: ChatsIcon },
};

export const TRACE_KINDS = Object.keys(TRACE_KIND) as TraceKind[];

export type TraceGroup = { head: string | null; events: TraceEvent[] };

/** An event without a head belongs to the head current at its time, so heads carry forward from the oldest event. The list is newest first: a group starts at its newest event. */
export function groupByHead(events: TraceEvent[]): TraceGroup[] {
  const heads: (string | null)[] = [];
  let current: string | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    current = events[i]!.head ?? current;
    heads[i] = current;
  }
  const out: TraceGroup[] = [];
  events.forEach((e, i) => {
    const last = out[out.length - 1];
    if (last && last.head === heads[i]) last.events.push(e);
    else out.push({ head: heads[i]!, events: [e] });
  });
  return out;
}

export const shortSha = (sha: string) => sha.slice(0, 7);

/** The person who pushed a head, when the trace has a push event for it. */
export function pushedBy(events: TraceEvent[], head: string): string | null {
  const p = events.find((e) => e.kind === "github" && e.head === head && e.ref.head === head && e.actor.type === "person" && /^Pushed /.test(e.summary));
  return p?.actor.name ?? null;
}

export const NEXT_LABEL: Record<string, string> = {
  verify: "Verify",
  premerge: "Pre-merge review",
  review: "Review",
  fixup: "Fix-up",
  merge: "Merge",
};
export const nextLabel = (kind: string) => NEXT_LABEL[kind] ?? kind.replace(/[-_]/g, " ").replace(/^./, (c) => c.toUpperCase());
