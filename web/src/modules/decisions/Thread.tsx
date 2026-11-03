import { useApi, useQuery } from "../../api/client";
import type { ViewProps } from "../../registry/types";
import { Avatar } from "../../ui/Avatar";
import { Count } from "../../ui/Heading";
import { ago } from "../../lib/format";
import { localActions, useDecisionList, useSelection } from "./state";
import { scrollToWorkflow } from "./Workflow";
import { OpinionList } from "./parts";
import { canAct } from "../../registry/permissions";
import { ReviewBox } from "./ReviewBox";

/** Desktop side panel: everyone's comments (operators can select a suggestion in the Workflow box), then the comment thread. */
export function ThreadPanel({ user }: ViewProps) {
  const api = useApi();
  const { id } = useSelection();
  const { data } = useDecisionList();
  const d = data?.decisions.find((x) => x.id === id);
  const operator = d ? canAct(user, d.items.length ? d.items.map((i) => i.repo) : [d.repo]) : false;
  const use = (option: string) => {
    if (!d) return;
    localActions.setPick(d.id, option);
    scrollToWorkflow();
  };
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-4 pr-10">
        <span className="text-xs font-semibold text-ink/70">Discussion</span>
      </div>
      {d ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <section className="border-b border-line p-3">
            <h2 className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-ink/60">
              Comments <Count n={d.opinions.length} />
            </h2>
            <OpinionList d={d} me={user.login} onUse={operator && !d.answer ? use : undefined} onRetract={() => void api.decisions.retract(d.id)} />
          </section>
          <h2 className="flex items-center gap-1.5 px-4 pt-3 text-xs font-semibold text-ink/60">
            Thread <Count n={d.commentCount} />
          </h2>
          <Thread decisionId={d.id} />
          <div className="mt-auto border-t border-line p-3">
            <ReviewBox d={d} />
          </div>
        </div>
      ) : (
        <p className="p-4 text-sm text-ink/50">No decision selected.</p>
      )}
    </div>
  );
}

export function Thread({ decisionId, compact }: { decisionId: string; compact?: boolean }) {
  const { data } = useQuery(`thread:${decisionId}`, (a) => a.decisions.thread(decisionId));
  const { data: list } = useDecisionList();
  const d = list?.decisions.find((x) => x.id === decisionId);
  const activity = d
    ? [
        { at: d.askedAt, text: `Asked by ${d.askedBy}` },
        ...(d.claim ? [{ at: d.claim.since, text: `${d.claim.login} opened it` }] : []),
      ]
    : [];

  return (
    <div className={compact ? "" : "flex min-h-0 flex-1 flex-col"}>
      <ol className={compact ? "space-y-4" : "min-h-0 flex-1 space-y-4 overflow-y-auto p-4"}>
        {activity.map((a, i) => (
          <li key={`a${i}`} className="flex items-center gap-2 text-xs text-ink/50">
            <span className="size-1.5 rounded-full bg-ink/30" />
            <span className="flex-1">{a.text}</span>
            <span>{ago(a.at)}</span>
          </li>
        ))}
        {data?.map((c) => (
          <li key={c.id} className="animate-fadeIn">
            <div className="flex items-center gap-2">
              <Avatar login={c.login} size={20} />
              <span className="text-sm font-semibold">{c.login}</span>
              <span className="ml-auto text-xs text-ink/45">{ago(c.at)}</span>
            </div>
            <p className="mt-1 pl-7 text-sm leading-5 text-ink/80">{c.body}</p>
          </li>
        ))}
        {data && data.length === 0 && <li className="text-sm text-ink/45">No comments yet.</li>}
      </ol>
    </div>
  );
}
