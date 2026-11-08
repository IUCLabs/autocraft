// The pre-approved merge of a PR with the operator's cancel and, once it failed, try again.
import { useState } from "react";
import { useApi } from "../../../api/client";
import type { Preapproval } from "../../../api/types";
import { PreapprovalRow } from "../../../ui/organisms/PreapprovalRow";
import { markStarting } from "../starting";
import { ErrorLine } from "../../admin/parts";

export function PreapprovalCard({ repo, number, p, operator }: { repo: string; number: number; p: Preapproval; operator: boolean }) {
  const api = useApi();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [applied, setApplied] = useState<Preapproval>();
  // The returned row shows at once; a newer server row (a later update time) replaces it.
  const shown = applied && applied.id === p.id && applied.updatedAt >= p.updatedAt ? applied : p;
  const act = (f: () => Promise<Preapproval>) => async () => {
    setBusy(true);
    setError(undefined);
    try {
      setApplied(await f());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const cancel = act(() => api.conversations.cancelPreapproval(repo, number));
  const retry = act(async () => {
    const p = await api.conversations.retryPreapproval(repo, number);
    markStarting(repo, number, "the pre-approved merge");
    return p;
  });
  return (
    <div className="border-b border-line px-4 py-3 md:px-6">
      <PreapprovalRow p={shown} repo={repo} number={number} canCancel={operator} onCancel={() => void cancel()} canRetry={operator} onRetry={() => void retry()} loading={busy} />
      <ErrorLine error={error} className="mt-2" />
    </div>
  );
}
