// Fast track and merge hold: the markers, the operator's toggles (Queue rows, decision page, item page) and the add box.
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
  const text = `Fast track ${fast.position} of ${fast.of}`;
  return (
    <span title={text} className="relative z-10 mt-0.5 inline-flex shrink-0 text-accent-ink">
      <FastForwardIcon size={14} weight="regular" aria-label={text} />
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

/** "Fast track an item": a GitHub link or `repo#n`; the server checks it. Operators only. */
export function FastTrackAdd() {
  const api = useApi();
  const operator = useUser().role === "operator";
  const write = useWrite();
  const [text, setText] = useState("");
  if (!operator) return null;
  return (
    <form
      className="flex flex-wrap items-center gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        const item = text.trim();
        if (item) void write.run("add", () => api.queueControl.fastTrackAdd(item)).then((ok) => ok && setText(""));
      }}
    >
      <TextInput aria-label="Fast track an item" placeholder="Fast track an item" title="A GitHub link or repo#n" value={text} onChange={(e) => setText(e.target.value)} className="h-7 w-[260px] max-md:h-11 max-md:w-[220px]" />
      <Button type="submit" size="sm" className="max-md:h-11" loading={write.busy === "add"} disabled={!text.trim()}>
        Add
      </Button>
      {write.error && <ErrorLine error={write.error} className="basis-full" />}
    </form>
  );
}
