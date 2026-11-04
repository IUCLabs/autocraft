import { useApi } from "../../api/client";
import type { TrackedRepo } from "../../api/types";
import { Badge } from "../../ui/atoms/Badge";
import { Button } from "../../ui/atoms/Button";
import { ago, num } from "../../lib/format";
import { useUser } from "../../shell/UserContext";
import { ConfirmButton } from "../../ui/molecules/ConfirmButton";
import { Switch } from "../../ui/atoms/Switch";
import { useWrite } from "../../lib/hooks";

export type Write = ReturnType<typeof useWrite>;
type WriteField = "labels" | "commenting" | "pushing" | "fixing" | "merging";

export interface WriteKind {
  field: WriteField;
  /** Row title on the detail page */
  name: string;
  /** Short badge on the list */
  short: string;
  /** What the pipeline does on GitHub when approved */
  line: string;
  run: (
    api: ReturnType<typeof useApi>,
    name: string,
    on: boolean,
  ) => Promise<unknown>;
}

/** In pipeline order. */
export const WRITES: WriteKind[] = [
  {
    field: "labels",
    name: "Labels",
    short: "Labels",
    line: "Writes labels to issues and pull requests",
    run: (a, n, on) => a.repoAdmin.approveLabels(n, on),
  },
  {
    field: "commenting",
    name: "Comment and close",
    short: "Comment",
    line: "Comments on and closes issues and pull requests",
    run: (a, n, on) => a.repoAdmin.approveCommenting(n, on),
  },
  {
    field: "pushing",
    name: "Push fix-ups",
    short: "Push",
    line: "Pushes fix-up commits to contributor branches",
    run: (a, n, on) => a.repoAdmin.approvePushing(n, on),
  },
  {
    field: "fixing",
    name: "Fix issues",
    short: "Fix",
    line: "Pushes issue fixes to the pipeline fork and opens pull requests and comments",
    run: (a, n, on) => a.repoAdmin.approveFixing(n, on),
  },
  {
    field: "merging",
    name: "Merge",
    short: "Merge",
    line: "Merges pull requests that pass the merge rules, through safe-merge",
    run: (a, n, on) => a.repoAdmin.approveMerging(n, on),
  },
];

export const approved = (r: TrackedRepo) =>
  WRITES.filter((w) => r[w.field]?.approved);

export function WriteBadges({ r }: { r: TrackedRepo }) {
  const on = approved(r);
  if (!on.length) return <span className="text-ink/40">None</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {on.map((w) => (
        <Badge key={w.field} tone="ok">
          {w.short}
        </Badge>
      ))}
    </span>
  );
}

export function Toggle({ r, write }: { r: TrackedRepo; write: Write }) {
  const api = useApi();
  const operator = useUser().role === "operator";
  const key = `${r.tracked ? "untrack" : "track"}:${r.name}`;
  if (!operator) return null;
  if (!r.tracked)
    return (
      <Button
        size="sm"
        loading={write.busy === key}
        onClick={() => void write.run(key, () => api.repoAdmin.track(r.name))}
        className="max-md:h-11"
      >
        Track
      </Button>
    );
  return (
    <ConfirmButton
      label="Untrack"
      confirmLabel="Untrack: hides its items"
      loading={write.busy === key}
      onConfirm={() => void write.run(key, () => api.repoAdmin.untrack(r.name))}
    />
  );
}

export function PipelineBadge({ r }: { r: TrackedRepo }) {
  if (!r.tracked) return <span className="text-ink/40">–</span>;
  return r.pipeline ? <Badge tone="ok">On</Badge> : <Badge>Off</Badge>;
}

/** The repo's pipeline switch for operators; others see the state. */
export function PipelineSwitch({ r, write }: { r: TrackedRepo; write: Write }) {
  const api = useApi();
  const operator = useUser().role === "operator";
  const key = `pipeline:${r.name}`;
  if (!r.tracked) return null;
  if (!operator) return <PipelineBadge r={r} />;
  return <Switch on={r.pipeline} label={`Pipeline in ${r.name}`} busy={write.busy === key} onChange={(on) => void write.run(key, () => api.repoAdmin.setPipeline(r.name, on))} />;
}

export const synced = (r: TrackedRepo) =>
  r.syncedAt ? `${ago(r.syncedAt, false)}` : "never";
export const maybe = (n: number | null) => (n === null ? "–" : num(n));
