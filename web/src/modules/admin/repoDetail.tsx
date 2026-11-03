import { Link } from "react-router-dom";
import { useApi, useQuery } from "../../api/client";
import type { TrackedRepo } from "../../api/types";
import type { ViewProps } from "../../registry/types";
import { Badge } from "../../ui/atoms/Badge";
import { num } from "../../lib/format";
import { useUser } from "../../shell/UserContext";
import { Block } from "../../ui/molecules/Block";
import { ConfirmButton } from "../../ui/molecules/ConfirmButton";
import { ErrorLine } from "../../ui/atoms/ErrorLine";
import { Page } from "../../ui/organisms/Page";
import { useWrite } from "../../lib/hooks";
import { PipelineBadge, PipelineToggle, Toggle, WRITES, maybe, synced, type Write, type WriteKind } from "./repoParts";
import { useNow } from "../../lib/useNow";

function Stat({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div title={title}>
      <div className="text-xs text-ink/55">{label}</div>
      <div className="num text-lg font-semibold">{value}</div>
    </div>
  );
}

function WriteRow({ r, w, write }: { r: TrackedRepo; w: WriteKind; write: Write }) {
  const api = useApi();
  const operator = useUser().role === "operator";
  const m = r[w.field];
  const key = `${w.field}:${r.name}`;
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-4 py-3 last:border-0">
      <div className="min-w-0 flex-1 basis-64">
        <div className="text-sm font-medium">{w.name}</div>
        <div className="text-sm text-ink/60">{w.line}</div>
      </div>
      <div className="flex items-center gap-3">
        <div className="text-right">
          {m?.approved ? <Badge tone="ok">Approved</Badge> : <Badge>Not approved</Badge>}
          {m?.approved && (
            <div className="num text-xs text-ink/50">
              {m.approvedBy} {m.approvedAt ?? ""}
            </div>
          )}
        </div>
        {!operator ? null : m?.approved ? (
          <ConfirmButton label="Stop" confirmLabel={w.stop} loading={write.busy === key} onConfirm={() => void write.run(key, () => w.run(api, r.name, false))} />
        ) : (
          <ConfirmButton label="Approve" confirmLabel={w.go} loading={write.busy === key} onConfirm={() => void write.run(key, () => w.run(api, r.name, true))} />
        )}
      </div>
    </li>
  );
}

function RepoDetailView({ params }: ViewProps) {
  useNow();
  const name = params.name ?? "";
  const { data, error } = useQuery("repo-admin", (a) => a.repoAdmin.list());
  const write = useWrite();
  const r = data?.find((x) => x.name === name);
  const l = r?.labels;

  return (
    <Page title={name}>
      <div className="mt-1 flex flex-wrap items-center gap-3 text-sm">
        <Link to="/repos" className="text-ink/60 hover:text-accent-ink hover:underline">
          Repos
        </Link>
        <a href={`https://github.com/storytold/${encodeURIComponent(name)}`} target="_blank" rel="noopener noreferrer" className="text-ink/60 hover:text-accent-ink hover:underline">
          GitHub
        </a>
        {r && (r.tracked ? <Badge tone="ok">Tracked</Badge> : <Badge>Not tracked</Badge>)}
        {r && <Toggle r={r} write={write} />}
        {r?.tracked && (
          <>
            <span className="text-ink/60">Pipeline</span>
            <PipelineBadge r={r} />
            <PipelineToggle r={r} write={write} />
          </>
        )}
      </div>
      <ErrorLine error={write.error ?? error?.message} className="mt-2" />
      {!data && !error && <p className="mt-4 text-sm text-ink/50">Loading…</p>}
      {data && !r && <p className="mt-4 text-sm text-ink/50">No such repo.</p>}
      {r && (
        <>
          <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label="Open PRs" value={maybe(r.openPrs)} />
            <Stat label="Open issues" value={maybe(r.openIssues)} />
            <Stat label="Rows in mirror" value={num(r.mirrored)} />
            <Stat label="Last synced" value={synced(r)} title={r.syncedAt ?? undefined} />
          </div>
          {r.tracked && (
            <>
              <Block className="mt-4" flush title="GitHub writes">
                <ul>
                  {WRITES.map((w) => (
                    <WriteRow key={w.field} r={r} w={w} write={write} />
                  ))}
                </ul>
              </Block>
              {l && (
                <Block className="mt-4" title="Labels plan">
                  <div className="num flex flex-wrap gap-x-6 gap-y-1 text-sm">
                    <span>{num(l.toAdd)} to add</span>
                    <span>{num(l.skipped)} skipped</span>
                    <span>{num(l.conflicts)} conflicts</span>
                  </div>
                </Block>
              )}
            </>
          )}
        </>
      )}
    </Page>
  );
}

export const repoDetailView = { id: "repo-detail", title: "Repo", panels: [{ id: "main", title: "Repo", component: RepoDetailView, defaultSize: 100 }] };
