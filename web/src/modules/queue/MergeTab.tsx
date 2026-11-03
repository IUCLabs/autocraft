// The Merge tab: what merges next, integration batches in flight, and the PRs not in a batch.
import { Link } from "react-router-dom";
import { useApi } from "../../api/client";
import type { MergeWait, NextMerge, QueueBatch, QueueMergeRow, QueuePage } from "../../api/types";
import { itemPath } from "../../lib/links";
import { useUser } from "../../shell/UserContext";
import { Badge, type Tone } from "../../ui/Badge";
import { RefLink } from "../../ui/RefLink";
import { Block, ConfirmButton, ErrorLine, useWrite } from "../admin/parts";
import { FastMark } from "./fastTrack";
import { BatchFacts, Cards, PrCard, PrRows, PrTableHead, Table, useRowOpen } from "./mergeParts";

const WAIT_TONE: Record<MergeWait, Tone> = { ready: "ok", refused: "bad", ci: "neutral", verify: "neutral", "re-review": "neutral", "batch-check": "neutral", "batch-ci": "neutral", held: "warn" };

function NextRow({ n, i }: { n: NextMerge; i: number }) {
  const to = itemPath(n.repo, n.number);
  const open = useRowOpen(to);
  return (
    <li onClick={open} className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-4 py-2 last:border-0 hover:bg-ink/[0.03]">
      <span className="num w-4 text-xs text-ink/45">{i + 1}</span>
      <span className="flex items-center gap-1">
        <FastMark fast={n.fast} />
        <RefLink repo={n.repo} number={n.number} kind="pr" className="text-xs" />
      </span>
      <Link to={to} className="min-w-[10rem] flex-1 font-medium hover:text-accent-ink hover:underline max-md:basis-full md:truncate">
        {n.title}
      </Link>
      {n.batch && <span className="font-mono text-2xs text-ink/55">{n.batch.branch}</span>}
      <Badge tone={WAIT_TONE[n.waitsFor]}>{n.label}</Badge>
    </li>
  );
}

function NextMerges({ items }: { items: NextMerge[] }) {
  if (items.length === 0) return null;
  return (
    <Block className="mt-3" flush title="Next merges">
      <ul>
        {items.map((n, i) => (
          <NextRow key={`${n.repo}#${n.number}`} n={n} i={i} />
        ))}
      </ul>
    </Block>
  );
}

const members = (b: QueueBatch) => b.prs as QueueMergeRow[];

function StopBatch({ b }: { b: QueueBatch }) {
  const api = useApi();
  const write = useWrite();
  if (useUser().role !== "operator") return null;
  return (
    <span className="ml-auto flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
      <ErrorLine error={write.error} className="text-2xs" />
      <ConfirmButton idle="secondary" label="Stop batch" confirmLabel="Confirm stop batch" loading={write.busy === "stop"} onConfirm={() => void write.run("stop", () => api.queueControl.stopBatch(b.id))} />
    </span>
  );
}

function BatchBlock({ batches, phone }: { batches: QueueBatch[]; phone: boolean }) {
  return (
    <Block className="mt-3" flush title="Integration batches">
      {phone ? (
        <ul>
          {batches.map((b) => (
            <li key={b.id} className="border-b border-line last:border-0">
              <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 bg-ink/[0.03] px-4 py-2.5">
                <BatchFacts b={b} />
                <StopBatch b={b} />
              </div>
              <ul className="border-t border-line">
                {members(b).map((r) => (
                  <PrCard key={r.number} r={r} inBatch />
                ))}
              </ul>
            </li>
          ))}
        </ul>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[960px] table-fixed border-collapse text-sm">
            <PrTableHead />
            {batches.map((b) => (
              <tbody key={b.id} className="border-b border-line last:border-0">
                <tr className="bg-ink/[0.03]">
                  <td colSpan={9} className="px-3 py-1.5">
                    <div className="flex min-h-7 flex-wrap items-center gap-x-3 gap-y-1">
                      <BatchFacts b={b} />
                      <StopBatch b={b} />
                    </div>
                  </td>
                </tr>
                {members(b).map((r) => (
                  <PrRows key={r.number} r={r} inBatch />
                ))}
              </tbody>
            ))}
          </table>
        </div>
      )}
    </Block>
  );
}

export function MergeTab({ page, rows, phone, more }: { page: QueuePage; rows: QueueMergeRow[]; phone: boolean; more?: { total: number; loading: boolean; load: () => void } }) {
  return (
    <>
      <NextMerges items={page.nextMerges} />
      {page.batches.length > 0 && <BatchBlock batches={page.batches} phone={phone} />}
      <Block className="mt-3" flush title="Not in a batch">
        {rows.length === 0 && <p className="px-4 py-6 text-sm text-ink/50">No PR in the queue.</p>}
        {rows.length > 0 && (phone ? <Cards rows={rows} /> : <Table rows={rows} />)}
        {more && (
          <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-2.5 text-xs text-ink/55">
            <span className="num">
              {rows.length} of {more.total}
            </span>
            <button className="chip max-md:h-11" disabled={more.loading} onClick={more.load}>
              Show more
            </button>
          </div>
        )}
      </Block>
    </>
  );
}
