// The hover card on an item's number: what the item is, who opened it, where it stands in the pipeline and what it closes. It reads
// the item when the card first opens (api.itemPeek) and keeps it for the next hover.
import type { ReactNode } from "react";
import { useQuery } from "../../api/client";
import { ItemIcon } from "../atoms/ItemIcon";
import { TimeAgo } from "../atoms/TimeAgo";
import { Tooltip } from "../atoms/Tooltip";
import { StatusLine } from "./StatusLine";

function PeekBody({ repo, number }: { repo: string; number: number }) {
  const { data, error } = useQuery(`item-peek:${repo}#${number}`, (a) => a.itemPeek(repo, number));
  if (!data) return <span className="text-ink/55">{error ? `Could not read ${repo}#${number}.` : `Reading ${repo}#${number}…`}</span>;
  const what = data.kind === "pr" ? "Pull request" : "Issue";
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-start gap-1.5">
        <ItemIcon kind={data.kind} state={data.state} tip={false} />
        <span className="font-medium text-ink [overflow-wrap:anywhere]">{data.title || `${repo}#${number}`}</span>
      </div>
      <div className="text-ink/55">
        {what} {repo}#{number}
        {data.author && <> · by {data.author}</>}
        {data.updatedAt && (
          <>
            {" · updated "}
            <TimeAgo iso={data.updatedAt} />
          </>
        )}
      </div>
      <StatusLine status={data.status} className="text-xs text-ink/70" />
      {(data.labels.length > 0 || data.closes.length > 0) && (
        <div className="flex flex-wrap gap-x-2 gap-y-1 text-ink/55">
          {data.labels.map((l) => (
            <span key={l} className="rounded-full border border-line px-1.5 text-2xs">
              {l}
            </span>
          ))}
          {data.closes.length > 0 && <span>Closes {data.closes.map((n) => `#${n}`).join(", ")}</span>}
        </div>
      )}
    </div>
  );
}

/** Puts the item's hover card on `children` (one element that takes a ref, usually the number link). */
export function ItemPeek({ repo, number, children }: { repo: string; number: number; children: ReactNode }) {
  return (
    <Tooltip content={<PeekBody repo={repo} number={number} />} align="start" className="w-[320px]">
      {children}
    </Tooltip>
  );
}
