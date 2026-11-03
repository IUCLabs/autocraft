// Merge queue: every PR with a take or take-fix review at its current head, and
// what it waits on. Read-only; merges are started from the Pipeline page.
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { GitMergeIcon } from "lucide-react";
import { useApi, useQuery } from "../../api/client";
import type { QueueFilter, QueueList, QueueRow, QueueState, Tier } from "../../api/types";
import type { FeatureModule, ViewProps } from "../../registry/types";
import { Badge, type Tone } from "../../ui/Badge";
import { RefLink } from "../../ui/RefLink";
import { cn } from "../../ui/cn";
import { ago, num } from "../../lib/format";
import { useIsPhone } from "../../shell/useMedia";
import { Block, ErrorLine, Page, selectCls, useUrlState } from "../admin/parts";

export const STATE: Record<QueueState, [string, Tone, string]> = {
  ready: ["Ready", "ok", "Covered by the merge rule; merges on the next run"],
  "decision-answered-merge": ["Merge approved", "ok", "The operator answered merge at this head; merges on the next run"],
  refused: ["Refused", "bad", "The merge command or a pre-merge check said no; tried again next run"],
  "waiting-ci": ["Waiting for CI", "neutral", "CI is pending or hasn't run, or GitHub is still checking mergeability"],
  "ci-failed": ["CI failed", "bad", "CI fails at this head"],
  conflict: ["Conflict", "bad", "Conflicts with the base branch"],
  "needs-fix-up": ["Needs fix-up", "warn", "The review lists small fixes; a later step makes them"],
  "waiting-verify": ["Waiting for Verify", "neutral", "No passed verification at this head yet: the build tasks are planned or running"],
  "verify-failed": ["Verify failed", "bad", "The build or tests failed at this head"],
  "verify-error": ["Verify error", "warn", "Verification could not run; it is retried once, then held"],
  "needs-decision": ["Needs a decision", "warn", "Outside the merge rule (size, label, author, not verified or no CI): waits for the operator's Merge? answer"],
  declined: ["Declined", "neutral", "The operator answered hold or close"],
  merged: ["Merged", "merged", "Merged"],
  "held-duplicate": ["Held: Duplicate?", "warn", "An open Duplicate? decision keeps it out of every later stage; answer it in Decisions"],
};
const STATES = Object.keys(STATE) as QueueState[];
const TIER: Record<Tier, string> = { whitelisted: "whitelisted", not: "not whitelisted", "override-allow": "override allow", "override-deny": "override deny" };
const CI_TONE: Record<QueueRow["ci"], Tone> = { success: "ok", failure: "bad", pending: "warn", none: "neutral", unknown: "neutral" };
const MERGEABLE: Record<QueueRow["mergeable"], [string, Tone]> = { clean: ["clean", "ok"], conflicts: ["conflicts", "bad"], unknown: ["unknown", "neutral"] };

function useFilter() {
  const { state, update } = useUrlState();
  const filter: QueueFilter = {
    repo: state.repo || undefined,
    state: STATES.includes(state.state as QueueState) ? (state.state as QueueState) : undefined,
  };
  return { filter, update };
}

// The first page for a filter, then more on request: pages append, a new filter starts over.
function usePagedQueue(filter: QueueFilter) {
  const api = useApi();
  const key = JSON.stringify(filter);
  const [data, setData] = useState<QueueList>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error>();
  const seq = useRef(0);
  const load = useCallback(
    (after: string | undefined) => {
      const mine = ++seq.current;
      setLoading(true);
      api.queue({ ...(JSON.parse(key) as QueueFilter), after }).then(
        (p) => {
          if (mine !== seq.current) return;
          setData((d) => (after && d ? { ...p, rows: [...d.rows, ...p.rows] } : p));
          setError(undefined);
          setLoading(false);
        },
        (e: Error) => mine === seq.current && (setError(e), setLoading(false)),
      );
    },
    [api, key],
  );
  useEffect(() => load(undefined), [load]);
  return { data, error, loading, loadMore: () => data?.next && load(data.next) };
}

function QueueView(_: ViewProps) {
  const { filter, update } = useFilter();
  const { data, error, loading, loadMore } = usePagedQueue(filter);
  const { data: repos } = useQuery("repos", (api) => api.repos());
  const phone = useIsPhone();
  // Merged PRs are listed only under their own state, so "any state" leaves them out.
  const all = data ? Object.entries(data.counts).reduce((a, [k, n]) => a + (k === "merged" ? 0 : n), 0) : undefined;
  const mergeable = data ? data.counts.ready + data.counts["decision-answered-merge"] : undefined;

  return (
    <Page
      title="Merge queue"
      sub={
        data && (
          <>
            {num(all!)} taken PR{all === 1 ? "" : "s"} · {num(mergeable!)} may merge now · {num(data.counts["needs-decision"])} wait for a decision · merges run from the Pipeline page
          </>
        )
      }
    >
      <div className="mt-4 flex flex-wrap items-center gap-1.5">
        <select aria-label="Repo" value={filter.repo ?? ""} onChange={(e) => update({ repo: e.target.value || null })} className={cn(selectCls, filter.repo ? "text-accent-ink" : "text-ink/70")}>
          <option value="">Every repo</option>
          {repos?.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        {phone ? (
          <select aria-label="State" value={filter.state ?? ""} onChange={(e) => update({ state: e.target.value || null })} className={cn(selectCls, filter.state ? "text-accent-ink" : "text-ink/70")}>
            <option value="">Any state{all !== undefined ? ` (${num(all)})` : ""}</option>
            {STATES.map((s) => (
              <option key={s} value={s}>
                {`${STATE[s][0]}${data ? ` (${num(data.counts[s])})` : ""}`}
              </option>
            ))}
          </select>
        ) : (
          <div role="group" aria-label="State" className="flex flex-wrap items-center gap-1">
            <button aria-pressed={!filter.state} data-active={!filter.state} className="chip max-md:h-11" onClick={() => update({ state: null })}>
              Any state <span className="num opacity-60">{all !== undefined ? num(all) : ""}</span>
            </button>
            {STATES.map((s) => (
              <button key={s} aria-pressed={filter.state === s} data-active={filter.state === s} title={STATE[s][2]} className="chip max-md:h-11" onClick={() => update({ state: filter.state === s ? null : s })}>
                {STATE[s][0]} <span className="num opacity-60">{data ? num(data.counts[s]) : ""}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <Block className="mt-3" flush title={filter.state ? STATE[filter.state][0] : "Taken PRs"} aside={loading && data ? "Updating…" : filter.state ? STATE[filter.state][2] : undefined}>
        <ErrorLine error={error?.message} className="p-4" />
        {data && data.rows.length === 0 && <p className="px-4 py-6 text-sm text-ink/50">No PR in the queue matches these filters.</p>}
        {data && data.rows.length > 0 && (phone ? <Cards rows={data.rows} /> : <Table rows={data.rows} />)}
        {data?.next && (
          <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-2.5 text-xs text-ink/55">
            <span className="num">
              {num(data.rows.length)} of {num(data.total)}
            </span>
            <button className="chip max-md:h-11" disabled={loading} onClick={loadMore}>
              {loading ? "Loading…" : "Show more"}
            </button>
          </div>
        )}
      </Block>
    </Page>
  );
}

function StateChip({ row }: { row: QueueRow }) {
  const [text, tone, hint] = STATE[row.state];
  const title = row.state === "refused" && row.refusedReason ? row.refusedReason : row.state === "declined" && row.answer ? `The operator answered ${row.answer}` : hint;
  return (
    <span title={title}>
      <Badge tone={tone}>{text}</Badge>
    </span>
  );
}

function DecisionLink({ row }: { row: QueueRow }) {
  if (!row.decisionId) return row.state === "needs-decision" ? <span className="text-2xs text-ink/45">asked on the next run</span> : <span className="text-ink/30">–</span>;
  return (
    <Link to={`/decisions/${encodeURIComponent(row.decisionId)}`} className="text-xs text-accent-ink hover:underline">
      {row.answer ? `Answered ${row.answer}` : "Open decision"}
    </Link>
  );
}

/** Why it waits, in one line: refusal reason, or what keeps it outside the rule. */
function Why({ row }: { row: QueueRow }) {
  if (row.state === "refused" && row.refusedReason) return <span className="text-2xs text-bad">{row.refusedReason}</span>;
  if (row.path === "rule") return <span className="text-2xs text-ink/45">by the rule</span>;
  if (row.outsideRule.length) return <span className="text-2xs text-ink/50">outside the rule: {row.outsideRule.join(", ")}</span>;
  return null;
}

const V_TONE: Record<string, Tone> = { unavailable: "warn", passed: "ok", "ci-enough": "ok", failed: "bad", error: "warn", running: "accent", planned: "neutral", stale: "neutral" };
const V_LABEL: Record<string, string> = { unavailable: "Not verified", passed: "Passed", "ci-enough": "CI is enough", failed: "Failed", error: "Error", running: "Running", planned: "Planned", stale: "Stale" };

/** The Verify result at the reviewed head; the summary shows on hover and below the badge. */
function VerifyCell({ row }: { row: QueueRow }) {
  const v = row.verify;
  if (!v) return <span className="text-ink/30">–</span>;
  const text = [v.summary, v.note].filter(Boolean).join(" · ");
  return (
    <span className="block" title={text || undefined}>
      <Badge tone={V_TONE[v.state] ?? "neutral"}>{V_LABEL[v.state] ?? v.state}</Badge>
      {v.kind && <span className="ml-1.5 text-2xs text-ink/50">{v.kind}</span>}
      {text && <span className="mt-0.5 line-clamp-2 block text-2xs text-ink/55">{text}</span>}
    </span>
  );
}

function Review({ row }: { row: QueueRow }) {
  return (
    <span className="block">
      <Badge tone={row.verdict === "take" ? "ok" : "warn"}>{row.verdict}</Badge>
      {row.fixes > 0 && <span className="ml-1.5 text-2xs text-ink/50">{row.fixes} fix{row.fixes === 1 ? "" : "es"}</span>}
      <span className="mt-0.5 block text-xs text-ink/65">{row.reason}</span>
    </span>
  );
}

function Table({ rows }: { rows: QueueRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[1300px] border-collapse text-sm">
        <thead className="bg-ink/[0.03] text-xs text-ink/55">
          <tr className="border-b border-line text-left">
            <th className="h-8 px-3 font-medium">PR</th>
            <th className="w-[130px] px-3 font-medium">Author</th>
            <th className="w-[50px] px-3 font-medium">Size</th>
            <th className="w-[100px] px-3 font-medium">Label</th>
            <th className="w-[220px] px-3 font-medium">Review</th>
            <th className="w-[80px] px-3 font-medium">CI</th>
            <th className="w-[200px] px-3 font-medium">Verify</th>
            <th className="w-[90px] px-3 font-medium">Mergeable</th>
            <th className="w-[130px] px-3 font-medium">State</th>
            <th className="w-[110px] px-3 font-medium">Decision</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.repo}#${r.number}`} className="border-b border-line align-top last:border-0 hover:bg-ink/[0.03]">
              <td className="px-3 py-2">
                <RefLink repo={r.repo} number={r.number} kind="pr" className="text-xs" />
                <Link to={`/item/${r.repo}/${r.number}`} className="line-clamp-2 font-medium hover:text-accent-ink hover:underline" title={r.title}>
                  {r.title}
                </Link>
                <div className="mt-0.5">
                  <Why row={r} />
                </div>
              </td>
              <td className="px-3 py-2">
                <div className="truncate text-ink/75">{r.author || "unknown"}</div>
                <div className="text-2xs text-ink/45">{TIER[r.tier]}</div>
              </td>
              <td className="num px-3 py-2 text-ink/70">{r.size}</td>
              <td className="px-3 py-2 text-xs text-ink/70">{r.label ?? <span className="text-ink/35">not settled</span>}</td>
              <td className="px-3 py-2">
                <Review row={r} />
              </td>
              <td className="px-3 py-2">
                <Badge tone={CI_TONE[r.ci]}>{r.ci}</Badge>
              </td>
              <td className="px-3 py-2">
                <VerifyCell row={r} />
              </td>
              <td className="px-3 py-2">
                <Badge tone={MERGEABLE[r.mergeable][1]}>{MERGEABLE[r.mergeable][0]}</Badge>
              </td>
              <td className="px-3 py-2">
                <StateChip row={r} />
                <div className="num mt-0.5 text-2xs text-ink/40" title={`reviewed ${r.reviewedAt.slice(0, 16).replace("T", " ")} at ${r.head.slice(0, 7)}`}>
                  reviewed {ago(r.reviewedAt)} ago
                </div>
              </td>
              <td className="px-3 py-2">
                <DecisionLink row={r} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Cards({ rows }: { rows: QueueRow[] }) {
  return (
    <ul>
      {rows.map((r) => (
        <li key={`${r.repo}#${r.number}`} className="border-b border-line px-4 py-2.5 last:border-0">
          <div className="flex items-center gap-2 text-xs text-ink/55">
            <RefLink repo={r.repo} number={r.number} kind="pr" className="text-xs" />
            <span className="truncate">
              {r.author || "unknown"} · {TIER[r.tier]}
            </span>
            <span className="ml-auto shrink-0">
              <StateChip row={r} />
            </span>
          </div>
          <Link to={`/item/${r.repo}/${r.number}`} className="mt-1 block text-sm font-medium leading-5 active:text-accent-ink">
            {r.title}
          </Link>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-2xs text-ink/60">
            <Badge tone={r.verdict === "take" ? "ok" : "warn"}>{r.verdict}</Badge>
            <span>size {r.size}</span>
            <span>{r.label ?? "not settled"}</span>
            <Badge tone={CI_TONE[r.ci]}>CI {r.ci}</Badge>
            <Badge tone={MERGEABLE[r.mergeable][1]}>{MERGEABLE[r.mergeable][0]}</Badge>
          </div>
          <p className="mt-1 text-xs text-ink/65">{r.reason}</p>
          {r.verify && (
            <div className="mt-1.5">
              <VerifyCell row={r} />
            </div>
          )}
          <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
            <Why row={r} />
            {r.decisionId && (
              <Link to={`/decisions/${encodeURIComponent(r.decisionId)}`} className="inline-flex h-11 items-center text-xs text-accent-ink">
                {r.answer ? `Answered ${r.answer}` : "Open decision"}
              </Link>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

export const queueModule: FeatureModule = {
  id: "queue",
  permission: "viewer",
  nav: { label: "Merge queue", icon: GitMergeIcon, to: "/queue", group: "work", order: 0.5 },
  commands: [{ id: "go-queue", keys: "g q", label: "Go to merge queue", group: "Go to" }],
  routes: [{ path: "queue", view: { id: "queue", title: "Merge queue", panels: [{ id: "main", title: "Merge queue", component: QueueView, defaultSize: 100 }] } }],
};
