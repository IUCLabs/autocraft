// The overflow menu on a Queue row: fast track, merge hold and, for batch members, remove from batch. Operators only.
import { DropdownMenu } from "radix-ui";
import { DotsThreeIcon, FastForwardIcon, PauseIcon, PlayIcon, SignOutIcon } from "@phosphor-icons/react";
import { useApi } from "../../api/client";
import type { FastPosition } from "../../api/types";
import { useUser } from "../../shell/UserContext";
import { ErrorLine, useWrite } from "../admin/parts";
import { refOf } from "./fastTrack";

const menuCls = "z-50 min-w-[200px] rounded-md border border-line-strong bg-raised p-1 shadow-[0_12px_32px_rgba(0,0,0,0.28)] animate-rise";
const itemCls = "flex h-8 cursor-default items-center gap-2.5 rounded px-2 text-sm outline-none data-[highlighted]:bg-ink/[0.07] max-md:h-11";

export function RowMenu({ repo, number, fast, held, pr, inBatch }: { repo: string; number: number; fast: FastPosition | null; held: boolean; pr: boolean; inBatch?: boolean }) {
  const api = useApi();
  const write = useWrite();
  if (useUser().role !== "operator") return null;
  const ref = refOf(repo, number);
  const run = (key: string, f: () => Promise<unknown>) => () => void write.run(key, f);
  return (
    <span className="inline-flex flex-col items-end" onClick={(e) => e.stopPropagation()}>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button type="button" aria-label={`Actions for ${ref}`} className="inline-flex size-7 items-center justify-center rounded text-ink/60 outline-none hover:bg-ink/[0.07] hover:text-ink data-[state=open]:bg-ink/[0.07] max-md:size-11">
            <DotsThreeIcon size={20} weight="bold" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="end" sideOffset={4} className={menuCls}>
            <DropdownMenu.Item className={itemCls} onSelect={run("fast", () => (fast ? api.queueControl.fastTrackRemove(ref) : api.queueControl.fastTrackAdd(ref)))}>
              <FastForwardIcon size={16} />
              {fast ? "Remove fast track" : "Fast track"}
            </DropdownMenu.Item>
            {pr && (
              <DropdownMenu.Item className={itemCls} onSelect={run("hold", () => (held ? api.queueControl.release(ref) : api.queueControl.hold(ref)))}>
                {held ? <PlayIcon size={16} /> : <PauseIcon size={16} />}
                {held ? "Release" : "Hold merge"}
              </DropdownMenu.Item>
            )}
            {inBatch && (
              <DropdownMenu.Item className={itemCls} onSelect={run("batch", () => api.queueControl.batchRemove(ref))}>
                <SignOutIcon size={16} />
                Remove from batch
              </DropdownMenu.Item>
            )}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <ErrorLine error={write.error} className="max-w-[180px] text-2xs" />
    </span>
  );
}
