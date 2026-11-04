// The merge queue (next merges, batches, PRs not in a batch) with its own paging, for pages that embed it.
import { useIsPhone } from "../../shell/useMedia";
import { ErrorLine } from "../admin/parts";
import { MergeTab } from "./MergeTab";
import { usePage } from "./usePage";

export function MergeQueue({ repos = "pipeline" }: { repos?: string }) {
  const phone = useIsPhone();
  const { pages, error, hasMore, loadingMore, loadMore } = usePage("merge", repos, undefined);
  const first = pages?.[0];
  const rows = pages?.flatMap((p) => p.mergeRows) ?? [];
  return (
    <>
      <ErrorLine error={error?.message} className="mt-3" />
      {first && <MergeTab page={first} rows={rows} phone={phone} more={hasMore ? { total: first.total, loading: loadingMore, load: loadMore } : undefined} />}
    </>
  );
}
