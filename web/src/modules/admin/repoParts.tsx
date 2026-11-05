import { useApi } from "../../api/client";
import type { TrackedRepo } from "../../api/types";
import { Badge } from "../../ui/atoms/Badge";
import { Button } from "../../ui/atoms/Button";
import { num, eventTime } from "../../lib/format";
import { useUser } from "../../shell/UserContext";
import { ConfirmButton } from "../../ui/molecules/ConfirmButton";
import { Switch } from "../../ui/atoms/Switch";
import { useWrite } from "../../lib/hooks";
import { setRepoOwners } from "../../lib/links";
import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Select } from "../../ui/atoms/Select";
import { Block } from "../../ui/molecules/Block";

export type Write = ReturnType<typeof useWrite>;

/**
 * useWrite for the repo-admin writes: each returns the full repo list, which replaces the cached list at once,
 * so a switch shows its new state without waiting for the live refetch (which is coalesced for up to 3 s).
 */
export function useRepoWrite(): Write {
  const qc = useQueryClient();
  const w = useWrite();
  const api = useApi();
  const { run: base } = w;
  const run = useCallback(
    (key: string, f: () => Promise<unknown>) =>
      base(key, async () => {
        const out = await f();
        if (Array.isArray(out)) {
          // Owners first: the views that re-render with the new list build links from them.
          await api.repoOwners().then(setRepoOwners, () => {});
          qc.setQueryData(["repo-admin"], out);
        }
        return out;
      }),
    [base, qc, api],
  );
  return { ...w, run };
}
type WriteField = "labels" | "commenting" | "pushing" | "fixing" | "mainFixing" | "ciApproving" | "merging";

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
    field: "mainFixing",
    name: "Fix red main",
    short: "Main",
    line: "Reruns flaky failed jobs on a red default branch and opens an issue on an operator's answer",
    run: (a, n, on) => a.repoAdmin.approveMainFixing(n, on),
  },
  {
    field: "ciApproving",
    name: "CI runs",
    short: "CI",
    line: "Approves waiting CI runs of reviewed outside pull requests",
    run: (a, n, on) => a.repoAdmin.approveCiRuns(n, on),
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
  r.syncedAt ? `${eventTime(r.syncedAt)}` : "never";
export const maybe = (n: number | null) => (n === null ? "–" : num(n));

/** The checks whose failure does not stop a merge: a list for everyone, with remove and add for operators. */
export function OptionalChecks({ r, write }: { r: TrackedRepo; write: Write }) {
  const api = useApi();
  const operator = useUser().role === "operator";
  const [pick, setPick] = useState("");
  const offered = r.seenChecks.filter((c) => !r.optionalChecks.includes(c));
  const choice = offered.includes(pick) ? pick : offered[0] ?? "";
  const key = `optional:${r.name}`;
  return (
    <Block className="mt-4" title="Optional checks">
      {!r.optionalChecks.length && <p className="text-sm text-ink/50">None</p>}
      <ul className="divide-y divide-line">
        {r.optionalChecks.map((c) => (
          <li key={c} className="flex items-center justify-between gap-3 py-1.5 text-sm">
            <span className="num min-w-0 break-words">{c}</span>
            {operator && (
              <Button size="sm" variant="ghost" loading={write.busy === `${key}:${c}`} onClick={() => void write.run(`${key}:${c}`, () => api.repoAdmin.setOptionalCheck(r.name, c, false))}>
                Remove
              </Button>
            )}
          </li>
        ))}
      </ul>
      {operator && offered.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Select aria-label="Check to add" value={choice} onChange={(e) => setPick(e.target.value)} className="min-w-0 max-w-full">
            {offered.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
          <Button size="sm" loading={write.busy === key} onClick={() => void write.run(key, () => api.repoAdmin.setOptionalCheck(r.name, choice, true))}>
            Add
          </Button>
        </div>
      )}
    </Block>
  );
}
