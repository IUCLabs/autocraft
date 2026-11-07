// The pre-approved merge of a PR with the operator's cancel.
import { useState } from "react";
import { useApi } from "../../../api/client";
import type { Preapproval } from "../../../api/types";
import { PreapprovalRow } from "../../../ui/organisms/PreapprovalRow";
import { ErrorLine } from "../../admin/parts";

export function PreapprovalCard({ repo, number, p, operator }: { repo: string; number: number; p: Preapproval; operator: boolean }) {
  const api = useApi();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [applied, setApplied] = useState<Preapproval>();
  // The returned row shows at once; a newer server row (a later update time) replaces it.
  const shown = applied && applied.id === p.id && applied.updatedAt >= p.updatedAt ? applied : p;
  const cancel = async () => {
    setBusy(true);
    setError(undefined);
    try {
      setApplied(await api.conversations.cancelPreapproval(repo, number));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="border-b border-line px-4 py-3 md:px-6">
      <PreapprovalRow p={shown} repo={repo} number={number} canCancel={operator} onCancel={() => void cancel()} loading={busy} />
      <ErrorLine error={error} className="mt-2" />
    </div>
  );
}
