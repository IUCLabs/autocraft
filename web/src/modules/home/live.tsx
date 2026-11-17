// What merges next in the page's project, on Home.
import { Link } from "react-router-dom";
import { useQuery } from "../../api/client";
import type { MergeWait } from "../../api/types";
import { num } from "../../lib/format";
import { Badge, type Tone } from "../../ui/atoms/Badge";
import { Tooltip } from "../../ui/atoms/Tooltip";
import { WorkableGroup, WorkableRow, WorkableTable, type WorkableColumn } from "../../ui/organisms/Workable";
import { Section } from "../../ui/molecules/Section";
import { ErrorLine } from "../admin/parts";

const WAIT_TONE: Record<MergeWait, Tone> = { ready: "ok", refused: "bad", ci: "neutral", premerge: "neutral", verify: "neutral", "re-review": "neutral", "batch-check": "accent", "batch-ci": "accent", held: "warn" };

const COLUMNS: WorkableColumn[] = [{ id: "waits", label: "Waits on", width: "240px", mdWidth: "200px", hint: "What the PR waits on before it merges" }];

/** The PRs that merge next in the page's project, in merge order (the number before the title), with what each waits on. */
export function ProjectMergeQueue({ repo }: { repo: string | undefined }) {
  const { data, error } = useQuery("queue-page:merge:project", (a) => a.queuePage({ tab: "merge", repos: "pipeline", limit: 1 }));
  const next = data?.nextMerges ?? [];
  const to = repo ? `/next?repo=${encodeURIComponent(repo)}` : "/next";
  return (
    <Section title="Merge queue" count={data?.counts.merge} to={to} linkLabel="Whole queue">
      <ErrorLine error={error?.message} />
      {data && next.length === 0 && <p className="border-t border-line py-3 text-sm text-ink/55">{data.counts.merge ? "No PR is lined up to merge next." : "No PR is in the merge queue."}</p>}
      {next.length > 0 && (
        <WorkableTable columns={COLUMNS} label="Merges next">
          <WorkableGroup title="Merges next" count={next.length} hint="In merge order">
            {next.map((n, i) => (
              <WorkableRow
                key={`${n.repo}#${n.number}`}
                item={{ repo: n.repo, number: n.number, kind: "pr", state: "open", title: n.title }}
                mark={<span className="num w-4 shrink-0 text-sm text-ink/45">{i + 1}</span>}
                cells={{
                  waits: (
                    <Tooltip content={n.label}>
                      <span tabIndex={0} className="inline-flex max-w-full outline-none">
                        <Badge tone={WAIT_TONE[n.waitsFor]} className="min-w-0 max-w-full shrink">
                          <span className="truncate">{n.label}</span>
                        </Badge>
                      </span>
                    </Tooltip>
                  ),
                }}
              />
            ))}
          </WorkableGroup>
        </WorkableTable>
      )}
      {data && data.counts.merge > next.length && (
        <Link to={to} className="mt-2 block text-xs text-ink/55 hover:text-ink">
          {next.length ? `${num(data.counts.merge - next.length)} more in the queue` : `${num(data.counts.merge)} in the queue`}
        </Link>
      )}
    </Section>
  );
}
