import { useState } from "react";
import { useApi, useQuery } from "../../api/client";
import type { ViewProps } from "../../registry/types";
import { Avatar } from "../../ui/Avatar";
import { Button } from "../../ui/Button";
import { Hud } from "../../ui/Hud";
import { Kbd } from "../../ui/Kbd";
import { ago } from "../../lib/format";
import { useDecisionList, useSelection } from "./state";
import { useUser } from "../../shell/UserContext";
import { canComment } from "../../registry/permissions";
import { LockIcon } from "lucide-react";

export function ThreadPanel(_: ViewProps) {
  const { id } = useSelection();
  const { data } = useDecisionList();
  const d = data?.decisions.find((x) => x.id === id);
  return (
    <div className="flex h-full min-h-0 flex-col bg-panel">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-4 pr-10">
        <Hud>Discussion</Hud>
        {d && <span className="font-mono text-2xs text-ink/45">{d.commentCount}</span>}
      </div>
      {d ? <Thread decisionId={d.id} /> : <p className="p-4 text-sm text-ink/50">No decision selected.</p>}
    </div>
  );
}

export function Thread({ decisionId, compact }: { decisionId: string; compact?: boolean }) {
  const api = useApi();
  const { data } = useQuery(`thread:${decisionId}`, (a) => a.decisions.thread(decisionId));
  const { data: list } = useDecisionList();
  const d = list?.decisions.find((x) => x.id === decisionId);
  const user = useUser();
  const [body, setBody] = useState("");
  const send = async () => {
    if (!body.trim()) return;
    await api.decisions.comment(decisionId, body.trim());
    setBody("");
  };

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
          <li key={`a${i}`} className="flex items-center gap-2 font-mono text-2xs text-ink/45">
            <span className="size-1 bg-ink/40" />
            <span className="flex-1">{a.text}</span>
            <span>{ago(a.at)}</span>
          </li>
        ))}
        {data?.map((c) => (
          <li key={c.id} className="animate-fadeIn">
            <div className="flex items-center gap-2">
              <Avatar login={c.login} size={18} />
              <span className="text-xs font-semibold">{c.login}</span>
              <span className="ml-auto font-mono text-2xs text-ink/40">{ago(c.at)}</span>
            </div>
            <p className="mt-1.5 pl-[26px] text-sm leading-[21px] text-ink/80">{c.body}</p>
          </li>
        ))}
        {data && data.length === 0 && <li className="text-sm text-ink/45">No comments yet.</li>}
      </ol>
      {d && !canComment(user, d.repo) ? (
        <p className={compact ? "mt-4 flex items-center gap-2 text-xs text-ink/50" : "flex items-center gap-2 border-t border-line p-3 text-xs text-ink/50"}>
          <LockIcon className="shrink-0" /> Read-only for you. Operators and, when enabled, maintainers comment here.
        </p>
      ) : (
      <div className={compact ? "mt-4" : "border-t border-line p-3"}>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
            if (e.key === "Escape") e.currentTarget.blur();
          }}
          rows={compact ? 2 : 3}
          placeholder="For people only: not posted on GitHub, never sent to the pipeline"
          aria-label="Comment"
          className="block w-full resize-none border border-line bg-sunken/40 px-2.5 py-2 text-sm outline-none placeholder:text-ink/35 focus:border-line-strong"
        />
        <div className="mt-2 flex items-center justify-between">
          {!compact && (
            <span className="flex items-center gap-1 font-mono text-2xs text-ink/40">
              <Kbd keys="ctrl ↵" /> to send
            </span>
          )}
          <Button size="sm" variant="secondary" className="ml-auto" onClick={() => void send()} disabled={!body.trim()}>
            Comment
          </Button>
        </div>
      </div>
      )}
    </div>
  );
}
