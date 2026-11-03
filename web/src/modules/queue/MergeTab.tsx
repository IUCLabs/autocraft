// The Merge tab: what merges next, integration batches in flight, and the PRs not in a batch.
import { useApi } from "../../api/client";
import type { MergeWait, NextMerge, QueueBatch, QueueMergeRow, QueuePage } from "../../api/types";
import { useUser } from "../../shell/UserContext";
import { Badge, type Tone } from "../../ui/atoms/Badge";
import { ItemRef } from "../../ui/molecules/ItemRef";
import { Block, ConfirmButton, ErrorLine, useWrite } from "../admin/parts";
import { FastMark } from "./fastTrack";
import { BatchFacts, Cards, PrCard, PrRows, PrTableHead, Table } from "./mergeParts";

const WAIT_TONE: Record<MergeWait, Tone> = { ready: "ok", refused: "bad", ci: "neutral", verify: "neutral", "re-review": "neutral", "batch-check": "neutral", "batch-ci": "neutral", held: "warn" };

function NextRow({ n, i }: { n: NextMerge; i: number }) {
  return (
    <li className="relative flex flex-wrap items-start gap-x-3 gap-y-1 border-b border-line px-4 py-2 last:border-0 hover:bg-ink/[0.03]">
      <span className="num mt-0.5 w-4 text-xs text-ink/45">{i + 1}</span>
      <FastMark fast={n.fast} />
      <ItemRef repo={n.repo} number={n.number} kind="pr" state="open" title={n.title} stretch className="min-w-[10rem] flex-1 max-md:basis-full" />
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
    <span className="ml-auto flex items-center gap-2">
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
