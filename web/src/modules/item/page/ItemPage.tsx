// The item page: a status line, then "In AutoCraft" and "On GitHub" side by side (a segmented control on phones).
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeftIcon, ArrowSquareOutIcon, DotsThreeIcon } from "@phosphor-icons/react";
import { DropdownMenu } from "radix-ui";
import { useQuery } from "../../../api/client";
import type { ItemPageData } from "../../../api/types";
import type { ViewProps } from "../../../registry/types";
import { Pending } from "../../../ui/atoms/Pending";
import { Badge } from "../../../ui/atoms/Badge";
import { ItemIcon } from "../../../ui/atoms/ItemIcon";
import { StatusLine } from "../../../ui/molecules/StatusLine";
import { Segmented } from "../../../ui/molecules/Segmented";
import { useIsPhone } from "../../../shell/useMedia";
import { useUser } from "../../../shell/UserContext";
import { cn } from "../../../ui/cn";
import { AutoCraftSide } from "./AutoCraftSide";
import { GithubSide } from "./GithubSide";

type Side = "autocraft" | "github";

/** Cross-links between the sides: a write on the GitHub side opens its run in History, and the other way round. */
interface Jump { to: (side: Side, anchor: string) => void }
const JumpContext = createContext<Jump>({ to: () => {} });
export const useJump = () => useContext(JumpContext);

const STATE_LABEL = { open: "Open", closed: "Closed", merged: "Merged" } as const;
const STATE_TONE = { open: "ok", closed: "neutral", merged: "merged" } as const;

export function ItemPageView({ params }: ViewProps) {
  const repo = params.repo!;
  const number = Number(params.number);
  const user = useUser();
  const phone = useIsPhone();
  // A `since` that still matches returns the last page, so a pushed refresh of an unchanged item costs one small reply.
  const key = `item-page:${repo}#${number}`;
  const last = useRef<{ key: string; page: ItemPageData } | null>(null);
  const { data, error } = useQuery<ItemPageData>(key, async (a) => {
    const prev = last.current?.key === key ? last.current.page : null;
    const r = await a.itemPage(repo, number, prev?.stamp);
    if ("unchanged" in r && prev) return prev;
    if ("unchanged" in r) throw new Error("unexpected empty answer");
    last.current = { key, page: r };
    return r;
  });
  const [side, setSide] = useState<Side>(user.role === "viewer" ? "github" : "autocraft");
  const [flash, setFlash] = useState<string | null>(null);
  const to = useCallback((s: Side, anchor: string) => {
    setSide(s);
    setFlash(anchor);
    setTimeout(() => document.getElementById(anchor)?.scrollIntoView({ block: "center", behavior: "smooth" }), 60);
    setTimeout(() => setFlash(null), 2200);
  }, []);
  // The phone default is the AutoCraft side for staff and when a question is open; viewers start on GitHub.
  useEffect(() => setSide(user.role === "viewer" ? "github" : "autocraft"), [repo, number, user.role]);
  if (!data) return <Pending error={error} />;
  return (
    <JumpContext.Provider value={{ to }}>
      <div className={cn("flex min-h-0 flex-col", phone ? "h-full overflow-y-auto" : "h-full")} data-flash={flash ?? undefined}>
        <Header d={data} />
        {phone ? (
          <>
            <div className="sticky top-0 z-20 border-b border-line bg-panel px-4 py-2">
              <Segmented label="Side" value={side} onChange={setSide} className="[&>button]:h-9 [&>button]:flex-1" options={[{ value: "autocraft", label: "AutoCraft" }, { value: "github", label: "GitHub" }]} />
            </div>
            {side === "autocraft" ? <AutoCraftSide d={data} flash={flash} /> : <GithubSide d={data} flash={flash} />}
          </>
        ) : (
          <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,11fr)_minmax(0,9fr)]">
            <div className="min-h-0 overflow-y-auto border-r border-line"><AutoCraftSide d={data} flash={flash} /></div>
            <div className="min-h-0 overflow-y-auto bg-bg/40"><GithubSide d={data} flash={flash} /></div>
          </div>
        )}
      </div>
    </JumpContext.Provider>
  );
}

function Header({ d }: { d: ItemPageData }) {
  const user = useUser();
  return (
    <header className="shrink-0 border-b border-line px-4 pb-3 pt-3 md:px-6">
      <div className="flex items-center gap-2 text-xs text-ink/60">
        <Link to="/items" className="inline-flex h-7 items-center gap-1 hover:text-ink max-md:h-11"><ArrowLeftIcon /> Items</Link>
      </div>
      <div className="mt-1 flex flex-wrap items-start gap-3">
        <div className="min-w-0 basis-full md:basis-0 md:flex-1">
          <h1 className="text-lg font-semibold leading-6 md:text-xl md:leading-7">
            <ItemIcon kind={d.kind} state={d.state} className="mr-2 inline-block align-[-2px]" />
            <span className="code mr-2 text-ink/60">{d.repo}#{d.number}</span>
            {d.title}
          </h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink/55">
            <Badge tone={STATE_TONE[d.state]}>{STATE_LABEL[d.state]}</Badge>
            <span>by {d.author}</span>
          </div>
        </div>
        <a href={d.github.url} target="_blank" rel="noopener noreferrer" className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded border border-line-strong bg-raised px-2.5 text-xs font-medium hover:bg-ink/[0.06] max-md:h-11">
          See in GitHub <ArrowSquareOutIcon />
        </a>
        {user.role === "operator" && (
          <DropdownMenu.Root>
            <DropdownMenu.Trigger aria-label="More actions" className="flex size-8 shrink-0 items-center justify-center rounded border border-line-strong hover:bg-ink/[0.06] max-md:size-11"><DotsThreeIcon weight="bold" /></DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content align="end" sideOffset={6} className="z-50 min-w-[190px] rounded-md border border-line-strong bg-raised p-1 shadow-[0_12px_32px_rgba(0,0,0,0.28)] animate-rise">
                {["Fast track", "Hold", "Review again", "Verify again"].map((l) => (
                  <DropdownMenu.Item key={l} className="flex h-8 cursor-default items-center rounded px-2 text-sm outline-none data-[highlighted]:bg-ink/[0.07] max-md:h-11">{l}</DropdownMenu.Item>
                ))}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        )}
      </div>
      <StatusLine status={d.status} className="mt-2.5 rounded bg-ink/[0.04] px-3 py-2" />
    </header>
  );
}
