import { PlayCircleIcon } from "@phosphor-icons/react";
import { useApi } from "../../api/client";
import type { NeedsStoppedRow } from "../../api/types";
import { EmptyState } from "../../ui/atoms/EmptyState";
import { ErrorLine } from "../../ui/atoms/ErrorLine";
import { TextLink } from "../../ui/atoms/TextLink";
import { ConfirmButton } from "../../ui/molecules/ConfirmButton";
import { StoppedRow } from "../../ui/molecules/StoppedRow";
import { useWrite } from "../../lib/hooks";
import { useUser } from "../../shell/UserContext";
import { FixGroup } from "./FixGroup";
import { useSummary } from "./state";

function Resume({ row, onDone }: { row: NeedsStoppedRow; onDone: () => void }) {
  const api = useApi();
  const write = useWrite();
  const operator = useUser().role === "operator";
  const r = row.resume;
  if (r.type === "fixes") return null;
  if (r.type === "link") return <TextLink to={r.to}>Open</TextLink>;
  if (!operator) return null;
  return (
    <div className="flex flex-col items-end gap-1">
      <ConfirmButton idle="secondary" label="Resume" confirmLabel="Confirm resume" loading={write.busy === "resume"} onConfirm={() => void write.run("resume", async () => { await api.pipeline.resumeTrip(r.stage); onDone(); })} />
      <ErrorLine error={write.error} />
    </div>
  );
}

export function StoppedTab() {
  const q = useSummary();
  const rows = q.data?.stopped ?? [];
  return (
    <div className="h-full overflow-y-auto">
      <ErrorLine error={q.error?.message} className="px-4 py-3" />
      {q.data && rows.length === 0 && <EmptyState icon={PlayCircleIcon}>Nothing is stopped.</EmptyState>}
      <ul className="mx-auto max-w-[900px]">
        {rows.map((r) => (r.kind === "fix-group" ? <FixGroup key={r.id} row={r} /> : <StoppedRow key={r.id} row={r} action={<Resume row={r} onDone={q.refetch} />} />))}
      </ul>
    </div>
  );
}
