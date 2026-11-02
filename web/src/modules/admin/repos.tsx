import { useState } from "react";
import { FolderGit2Icon } from "lucide-react";
import { useApi, useQuery } from "../../api/client";
import type { TrackedRepo } from "../../api/types";
import type { FeatureModule, ViewProps } from "../../registry/types";
import { Badge } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import { cn } from "../../ui/cn";
import { ago, num } from "../../lib/format";
import { useIsPhone } from "../../shell/useMedia";
import { Block, ConfirmButton, ErrorLine, Page, SortTh, TextInput, useWrite } from "./parts";

type Show = "all" | "tracked" | "untracked";

function ReposView(_: ViewProps) {
  const api = useApi();
  const { data, error } = useQuery("repo-admin", (a) => a.repoAdmin.list());
  const [show, setShow] = useState<Show>("all");
  const [name, setName] = useState("");
  const write = useWrite();
  const phone = useIsPhone();
  const tracked = data?.filter((r) => r.tracked).length ?? 0;
  const rows = data?.filter((r) => show === "all" || (show === "tracked") === r.tracked) ?? [];

  const add = () => {
    const n = name.trim();
    if (n) void write.run(`track:${n}`, () => api.repoAdmin.track(n)).then((ok) => ok && setName(""));
  };

  return (
    <Page title="Repos" sub={data && `${tracked} of ${data.length} repos tracked`}>
      <p className="mt-2 max-w-[80ch] text-sm text-ink/65">
        Sync, the pipeline and every page work on tracked repos only. Switching a repo on takes effect at the next sync. Rows of an untracked repo stay in the mirror but are hidden. The Label stage writes labels to GitHub only for repos approved here; the plan counts show what it would do.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <div role="radiogroup" aria-label="Show" className="flex items-center gap-1">
          {(
            [
              ["all", "All", data?.length],
              ["tracked", "Tracked", tracked],
              ["untracked", "Not tracked", data ? data.length - tracked : undefined],
            ] as [Show, string, number | undefined][]
          ).map(([v, label, n]) => (
            <button key={v} role="radio" aria-checked={show === v} data-active={show === v} className="chip" onClick={() => setShow(v)}>
              {label} <span className="num opacity-60">{n ?? ""}</span>
            </button>
          ))}
        </div>
        <form
          className="flex w-full items-center gap-2 sm:ml-auto sm:w-auto"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="Repo name" aria-label="Repo to track" className="flex-1 sm:w-48" />
          <Button type="submit" disabled={!name.trim()} loading={write.busy === `track:${name.trim()}`} className="max-md:h-11">
            Track
          </Button>
        </form>
      </div>
      <ErrorLine error={write.error ?? error?.message} className="mt-2" />

      <Block className="mt-3" flush title="Org repos" aside={phone ? undefined : "Open counts come from the last sync"}>
        {!data && !error && <p className="p-4 text-sm text-ink/50">Loading…</p>}
        {data && (phone ? <Cards rows={rows} write={write} /> : <Table rows={rows} write={write} />)}
      </Block>
    </Page>
  );
}

type Write = ReturnType<typeof useWrite>;

function Toggle({ r, write }: { r: TrackedRepo; write: Write }) {
  const api = useApi();
  const key = `${r.tracked ? "untrack" : "track"}:${r.name}`;
  if (!r.tracked)
    return (
      <Button size="sm" loading={write.busy === key} onClick={() => void write.run(key, () => api.repoAdmin.track(r.name))} className="max-md:h-11">
        Track
      </Button>
    );
  return <ConfirmButton label="Untrack" confirmLabel="Untrack: hides its items" loading={write.busy === key} onConfirm={() => void write.run(key, () => api.repoAdmin.untrack(r.name))} />;
}

function Approval({ r, write }: { r: TrackedRepo; write: Write }) {
  const api = useApi();
  const l = r.labels;
  if (!l) return <span className="text-ink/40">–</span>;
  const key = `labels:${r.name}`;
  return (
    <div className="flex items-center justify-end gap-2">
      {l.approved ? (
        <span title={`Approved by ${l.approvedBy} ${l.approvedAt ?? ""}`}>
          <Badge tone="ok">Approved</Badge>
        </span>
      ) : (
        <Badge>Not approved</Badge>
      )}
      {l.approved ? (
        <ConfirmButton label="Stop" confirmLabel="Stop labelling here" loading={write.busy === key} onConfirm={() => void write.run(key, () => api.repoAdmin.approveLabels(r.name, false))} />
      ) : (
        <ConfirmButton label="Approve" confirmLabel="Approve: writes to GitHub" loading={write.busy === key} onConfirm={() => void write.run(key, () => api.repoAdmin.approveLabels(r.name, true))} />
      )}
    </div>
  );
}

type Kind = { field: "merging" | "pushing" | "commenting" | "fixing"; badge: string; stop: string; go: string; run: (api: ReturnType<typeof useApi>, name: string, on: boolean) => Promise<unknown> };
const KINDS: Record<Kind["field"], Kind> = {
  merging: { field: "merging", badge: "Merging approved", stop: "Stop merging here", go: "Approve: merges on GitHub", run: (a, n, on) => a.repoAdmin.approveMerging(n, on) },
  pushing: { field: "pushing", badge: "Push approved", stop: "Stop pushing here", go: "Approve: pushes to contributor branches", run: (a, n, on) => a.repoAdmin.approvePushing(n, on) },
  commenting: { field: "commenting", badge: "Comments approved", stop: "Stop commenting here", go: "Approve: comments and closes on GitHub", run: (a, n, on) => a.repoAdmin.approveCommenting(n, on) },
  fixing: { field: "fixing", badge: "Issue fixes approved", stop: "Stop fixing issues here", go: "Approve: pushes to the pipeline fork, PRs and comments", run: (a, n, on) => a.repoAdmin.approveFixing(n, on) },
};

function WriteApproval({ r, write, kind }: { r: TrackedRepo; write: Write; kind: Kind["field"] }) {
  const api = useApi();
  const k = KINDS[kind];
  const m = r[kind];
  if (!m) return <span className="text-ink/40">–</span>;
  const key = `${kind}:${r.name}`;
  return (
    <div className="flex items-center justify-end gap-2">
      {m.approved ? (
        <span title={`Approved by ${m.approvedBy} ${m.approvedAt ?? ""}`}>
          <Badge tone="ok">{k.badge}</Badge>
        </span>
      ) : (
        <Badge>Not approved</Badge>
      )}
      {m.approved ? (
        <ConfirmButton label="Stop" confirmLabel={k.stop} loading={write.busy === key} onConfirm={() => void write.run(key, () => k.run(api, r.name, false))} />
      ) : (
        <ConfirmButton label="Approve" confirmLabel={k.go} loading={write.busy === key} onConfirm={() => void write.run(key, () => k.run(api, r.name, true))} />
      )}
    </div>
  );
}

const MergeApproval = ({ r, write }: { r: TrackedRepo; write: Write }) => <WriteApproval r={r} write={write} kind="merging" />;

const planText = (r: TrackedRepo) => (r.labels ? `${num(r.labels.toAdd)} to add · ${num(r.labels.skipped)} skipped · ${num(r.labels.conflicts)} conflicts` : "–");

const synced = (r: TrackedRepo) => (r.syncedAt ? `${ago(r.syncedAt, false)}` : "never");
const maybe = (n: number | null) => (n === null ? "–" : num(n));

function Table({ rows, write }: { rows: TrackedRepo[]; write: Write }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[2100px] border-collapse text-sm">
        <thead className="bg-ink/[0.03] text-xs">
          <tr className="border-b border-line">
            <SortTh>Repo</SortTh>
            <SortTh className="w-[110px]">Status</SortTh>
            <SortTh right className="w-[90px]">Open PRs</SortTh>
            <SortTh right className="w-[100px]">Open issues</SortTh>
            <SortTh right className="w-[120px]">Rows in mirror</SortTh>
            <SortTh className="w-[150px]">Last synced</SortTh>
            <SortTh className="w-[270px]">Labels plan</SortTh>
            <th className="w-[270px] px-3 text-right text-xs font-medium">Label approval</th>
            <th className="w-[290px] px-3 text-right text-xs font-medium">Merge approval</th>
            <th className="w-[290px] px-3 text-right text-xs font-medium">Push fix-ups</th>
            <th className="w-[290px] px-3 text-right text-xs font-medium">Comment and close</th>
            <th className="w-[290px] px-3 text-right text-xs font-medium">Fix issues</th>
            <th className="w-[190px]" aria-label="Change" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name} className={cn("h-9 border-b border-line last:border-0 hover:bg-ink/[0.03]", !r.tracked && "text-ink/60")}>
              <td className="code px-3">{r.name}</td>
              <td className="px-3">{r.tracked ? <Badge tone="ok">Tracked</Badge> : <Badge>Not tracked</Badge>}</td>
              <td className="num px-3 text-right">{maybe(r.openPrs)}</td>
              <td className="num px-3 text-right">{maybe(r.openIssues)}</td>
              <td className="num px-3 text-right">{num(r.mirrored)}</td>
              <td className="px-3 text-ink/60" title={r.syncedAt ?? undefined}>
                {synced(r)}
              </td>
              <td className="num whitespace-nowrap px-3 text-ink/70">{planText(r)}</td>
              <td className="px-3">
                <Approval r={r} write={write} />
              </td>
              <td className="px-3">
                <MergeApproval r={r} write={write} />
              </td>
              <td className="px-3">
                <WriteApproval r={r} write={write} kind="pushing" />
              </td>
              <td className="px-3">
                <WriteApproval r={r} write={write} kind="commenting" />
              </td>
              <td className="px-3">
                <WriteApproval r={r} write={write} kind="fixing" />
              </td>
              <td className="px-3 text-right">
                <Toggle r={r} write={write} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Cards({ rows, write }: { rows: TrackedRepo[]; write: Write }) {
  return (
    <ul>
      {rows.map((r) => (
        <li key={r.name} className="flex items-center gap-3 border-b border-line px-4 py-2.5 last:border-0">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="code truncate">{r.name}</span>
              {r.tracked ? <Badge tone="ok">Tracked</Badge> : <Badge>Not tracked</Badge>}
            </div>
            <div className="num mt-0.5 text-xs text-ink/55">
              {maybe(r.openPrs)} PRs · {maybe(r.openIssues)} issues · synced {synced(r)}
            </div>
            {r.labels && <div className="num mt-0.5 text-xs text-ink/55">Labels plan: {planText(r)}</div>}
            {r.labels && (
              <div className="mt-1 flex items-center gap-2">
                <span className="num w-28 shrink-0 text-xs text-ink/55">Labels</span>
                <Approval r={r} write={write} />
              </div>
            )}
            {(["merging", "pushing", "commenting", "fixing"] as const).map((f) =>
              r[f] ? (
                <div key={f} className="mt-1 flex items-center gap-2">
                  <span className="num w-28 shrink-0 text-xs text-ink/55">{{ merging: "Merging", pushing: "Push fix-ups", commenting: "Comment and close", fixing: "Fix issues" }[f]}:</span>
                  <WriteApproval r={r} write={write} kind={f} />
                </div>
              ) : null,
            )}
          </div>
          <Toggle r={r} write={write} />
        </li>
      ))}
    </ul>
  );
}

export const reposModule: FeatureModule = {
  id: "repos",
  permission: "operator",
  nav: { label: "Repos", icon: FolderGit2Icon, to: "/repos", group: "operator", order: 20 },
  routes: [{ path: "repos", permission: "operator", view: { id: "repos", title: "Repos", panels: [{ id: "main", title: "Repos", component: ReposView, defaultSize: 100 }] } }],
};
