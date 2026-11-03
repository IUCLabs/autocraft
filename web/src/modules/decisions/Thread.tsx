import { useState } from "react";
import { useApi, useQuery } from "../../api/client";
import type { Decision } from "../../api/types";
import type { ViewProps } from "../../registry/types";
import { Avatar } from "../../ui/Avatar";
import { cn } from "../../ui/cn";
import { Count } from "../../ui/Heading";
import { ago } from "../../lib/format";
import { localActions, useDecisionList, usePinned, useSelection } from "./state";
import { scrollToWorkflow } from "./Workflow";
import { canAct, canComment } from "../../registry/permissions";
import { FeedbackBox } from "./FeedbackBox";
import { Conversation } from "./Conversation";
import { Segmented } from "../../ui/Segmented";
import { useNow } from "../../lib/useNow";

/** Desktop side panel: the Opus conversation and the feedback on the decision. Operators select a pick in the Workflow box. */
export function ThreadPanel({ user }: ViewProps) {
  const api = useApi();
  const { id } = useSelection();
  const { data } = useDecisionList();
  const inList = data?.decisions.find((x) => x.id === id);
  const pinned = usePinned(id, !!inList);
  const d = inList ?? pinned;
  const operator = d ? canAct(user, d.items.length ? d.items.map((i) => i.repo) : [d.repo]) : false;
  const use = (option: string) => {
    if (!d) return;
    localActions.setPick(d.id, option);
    scrollToWorkflow();
  };
  const [tab, setTab] = useState<"opus" | "feedback">("opus");
  const conversation = d && d.number !== null;
  const showOpus = !!conversation && tab === "opus";
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-4 pr-10">
        {conversation ? (
          <Segmented label="Panel" value={tab} onChange={setTab} options={[{ value: "opus", label: "Opus" }, { value: "feedback", label: "Feedback", count: d.commentCount + d.opinions.length }]} />
        ) : (
          <span className="flex items-center gap-1.5 text-xs font-semibold text-ink/70">
            Feedback {d && <Count n={d.commentCount + d.opinions.length} />}
          </span>
        )}
      </div>
      {d && conversation && (
        <div className={showOpus ? "min-h-0 flex-1 overflow-y-auto p-4" : "hidden"}>
          <Conversation repo={d.repo} number={d.number!} operator={operator} />
        </div>
      )}
      {d ? (
        <div className={showOpus ? "hidden" : "flex min-h-0 flex-1 flex-col"}>
          <FeedbackList d={d} me={user.login} onUse={operator && !d.answer ? use : undefined} onRetract={canComment(user) && !d.answer ? () => void api.decisions.retract(d.id) : undefined} />
          {canComment(user) && (
            <div className="border-t border-line p-3">
              <FeedbackBox d={d} />
            </div>
          )}
        </div>
      ) : (
        <p className="p-4 text-sm text-ink/50">No decision selected.</p>
      )}
    </div>
  );
}

/**
 * Everything people said about a decision, oldest first: picks (with their text) and plain
 * text. `onUse` selects a pick's option in the Workflow box; `onRetract` withdraws the viewer's own pick.
 */
export function FeedbackList({ d, me, onUse, onRetract, compact }: { d: Decision; me: string; onUse?: (option: string) => void; onRetract?: () => void; compact?: boolean }) {
  useNow();
  const { data: thread } = useQuery(`thread:${d.id}`, (a) => a.decisions.thread(d.id));
  const label = (k: string) => d.options.find((o) => o.key === k)?.label ?? k;
  const entries = [
    ...d.opinions.map((o) => ({ id: o.id, login: o.login, at: o.at, text: o.note, pick: o.option, write: o.permission === "write", own: o.login === me })),
    ...(thread ?? []).map((c) => ({ id: c.id, login: c.login, at: c.at, text: c.body, pick: null as string | null, write: false, own: false })),
  ].sort((x, y) => x.at.localeCompare(y.at));
  return (
    <ol className={compact ? "space-y-3.5" : "min-h-0 flex-1 space-y-4 overflow-y-auto p-4"}>
      {entries.map((e) => (
        <li key={e.id} className="animate-fadeIn">
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
            <span className="flex min-w-0 items-center gap-1.5">
              <Avatar login={e.login} size={20} />
              <span className="text-sm font-semibold">{e.login === me ? "You" : e.login}</span>
              {e.pick && (
                <>
                  <span className="text-sm text-ink/55">suggests</span>
                  <span className="text-sm font-medium">{label(e.pick)}</span>
                </>
              )}
            </span>
            <span className="ml-auto flex shrink-0 items-center gap-1.5">
              {e.pick && (
                <span
                  className={cn("whitespace-nowrap rounded-full border px-1.5 text-2xs leading-4", e.write ? "border-ok/40 text-ok" : "border-line-strong text-ink/50")}
                  title={e.write ? `Has write access to ${d.repo}` : `No write access to ${d.repo}`}
                >
                  {e.write ? "write" : "no write"}
                </span>
              )}
              <span className="text-xs text-ink/45">{ago(e.at)}</span>
            </span>
          </div>
          {e.text && <p className="mt-1 whitespace-pre-wrap break-words pl-7 text-sm leading-5 text-ink/80">{e.text}</p>}
          {((e.own && onRetract) || (e.pick && onUse)) && (
            <div className="mt-1 flex gap-3 pl-7">
              {e.own && onRetract && (
                <button onClick={onRetract} className="text-xs text-accent-ink hover:underline max-md:min-h-11">
                  Retract
                </button>
              )}
              {onUse && e.pick && e.write && (
                <button
                  onClick={() => onUse(e.pick!)}
                  className="rounded border border-line-strong px-2 py-0.5 text-left text-xs font-medium hover:border-accent/60 hover:text-accent-ink"
                  title={`Select "${label(e.pick)}" in the Workflow box`}
                >
                  Use this answer
                </button>
              )}
            </div>
          )}
        </li>
      ))}
      {entries.length === 0 && <li className="text-sm text-ink/45">No feedback yet.</li>}
    </ol>
  );
}
