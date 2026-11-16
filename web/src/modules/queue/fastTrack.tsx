// Fast track and merge hold: the markers, the operator's toggles (Queue rows, decision page, item page) and the add box.
import { cn } from "../../ui/cn";
import { useState } from "react";
import { FastForwardIcon, PauseIcon, PlayIcon } from "@phosphor-icons/react";
import { useApi, useQuery } from "../../api/client";
import type { FastPosition } from "../../api/types";
import { useUser } from "../../shell/UserContext";
import { Button } from "../../ui/atoms/Button";
import { ErrorLine, TextInput, useWrite } from "../admin/parts";

export const refOf = (repo: string, number: number) => `${repo}#${number}`;

export function useFastTrack() {
  const { data } = useQuery("fast-track", (api) => api.fastTrack());
  return data ?? [];
}

export function useHeldMerges() {
  const { data } = useQuery("merge-held", (api) => api.heldMerges());
  return data ?? [];
}

/** The marker before an item's ref; its tooltip gives the place among the fast-tracked items. */
export function FastMark({ fast }: { fast: FastPosition | null | undefined }) {
  if (!fast) return null;
  const text = `Fast track ${fast.position} of ${fast.of}${fast.weight === undefined ? "" : `, weight ${fast.weight}`}`;
  return (
    <span title={text} className="relative z-10 mt-0.5 inline-flex shrink-0 items-center gap-0.5 text-accent-ink">
      <FastForwardIcon size={14} weight="regular" aria-label={text} />
      {fast.weight !== undefined && <span className="num text-2xs font-semibold">{fast.weight}</span>}
    </span>
  );
}

/** The marker for an item known by repo and number (decision and item pages). */
export function FastMarkFor({ repo, number }: { repo: string; number: number }) {
  const refs = useFastTrack();
  const i = refs.indexOf(refOf(repo, number));
  return <FastMark fast={i < 0 ? null : { position: i + 1, of: refs.length }} />;
}

/** Operators only. */
export function FastToggle({ repo, number, className }: { repo: string; number: number; className?: string }) {
  const api = useApi();
  const operator = useUser().role === "operator";
  const refs = useFastTrack();
  const write = useWrite();
  if (!operator) return null;
  const ref = refOf(repo, number);
  const on = refs.includes(ref);
  return (
    <>
      <Button
        size="sm"
        icon={FastForwardIcon}
        loading={write.busy === "fast"}
        className={className ?? "max-md:h-11"}
        onClick={() => void write.run("fast", () => (on ? api.queueControl.fastTrackRemove(ref) : api.queueControl.fastTrackAdd(ref)))}
      >
        {on ? "Remove fast track" : "Fast track"}
      </Button>
      {write.error && <ErrorLine error={write.error} />}
    </>
  );
}

/** Operators only; for pull requests. */
export function HoldToggle({ repo, number, className }: { repo: string; number: number; className?: string }) {
  const api = useApi();
  const operator = useUser().role === "operator";
  const held = useHeldMerges();
  const write = useWrite();
  if (!operator) return null;
  const ref = refOf(repo, number);
  const on = held.includes(ref);
  return (
    <>
      <Button
        size="sm"
        icon={on ? PlayIcon : PauseIcon}
        loading={write.busy === "hold"}
        className={className ?? "max-md:h-11"}
        onClick={() => void write.run("hold", () => (on ? api.queueControl.release(ref) : api.queueControl.hold(ref)))}
      >
        {on ? "Release" : "Hold merge"}
      </Button>
      {write.error && <ErrorLine error={write.error} />}
    </>
  );
}

const WEIGHTS = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1];

/** A weight from 1 to 10; heavier items go first. */
function WeightSelect({ value, onChange, disabled, className }: { value: number; onChange: (w: number) => void; disabled?: boolean; className?: string }) {
  return (
    <select
      aria-label="Weight"
      title="Weight: heavier items go first"
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(Number(e.target.value))}
      className={cn("relative z-10 h-7 rounded border border-line bg-sunken px-1.5 text-xs max-md:h-11", className)}
    >
      {WEIGHTS.map((w) => (
        <option key={w} value={w}>
          {w === 10 ? "10 (first)" : w === 5 ? "5 (default)" : w === 1 ? "1 (last)" : w}
        </option>
      ))}
    </select>
  );
}

/** The weight of a fast-tracked item; operators change it here. */
export function WeightControl({ repo, number, weight }: { repo: string; number: number; weight: number }) {
  const api = useApi();
  const write = useWrite();
  if (useUser().role !== "operator") return <span className="num text-xs text-ink/70" title="Fast-track weight">{weight}</span>;
  return (
    <span className="inline-flex items-center gap-1">
      <WeightSelect value={weight} disabled={write.busy === "weight"} onChange={(w) => void write.run("weight", () => api.queueControl.fastTrackWeight(refOf(repo, number), w))} className="h-6 px-1 text-2xs" />
      {write.error && <ErrorLine error={write.error} className="text-2xs" />}
    </span>
  );
}

/**
 * "Add to merge queue": a GitHub link or `repo#n` and a weight. The server pre-approves the merge at the PR's current head (it merges once
 * the review there says take, the pre-merge review is clean and CI is green) and fast-tracks it with the weight. Operators only.
 */
export function QueueAdd() {
  const api = useApi();
  const operator = useUser().role === "operator";
  const write = useWrite();
  const [text, setText] = useState("");
  const [weight, setWeight] = useState(5);
  const [done, setDone] = useState<string | null>(null);
  if (!operator) return null;
  return (
    <form
      className="flex flex-wrap items-center gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        const item = text.trim();
        if (!item) return;
        setDone(null);
        void write.run("queue-add", async () => setDone((await api.queueControl.add(item, weight)).label)).then((ok) => ok && setText(""));
      }}
    >
      <TextInput aria-label="Add a PR to the merge queue" placeholder="Add a PR to the merge queue" title="A GitHub link or repo#n" value={text} onChange={(e) => setText(e.target.value)} className="h-7 w-[260px] max-md:h-11 max-md:w-[200px]" />
      <WeightSelect value={weight} onChange={setWeight} />
      <Button type="submit" size="sm" className="max-md:h-11" loading={write.busy === "queue-add"} disabled={!text.trim()}>
        Add
      </Button>
      {write.error && <ErrorLine error={write.error} className="basis-full" />}
      {done && !write.error && <span className="basis-full text-xs text-ok">{done}</span>}
    </form>
  );
}
