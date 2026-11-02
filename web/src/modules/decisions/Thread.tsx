import { useState } from "react";
import { useApi, useQuery } from "../../api/client";
import type { ViewProps } from "../../registry/types";
import { Avatar } from "../../ui/Avatar";
import { Button } from "../../ui/Button";
import { Count } from "../../ui/Heading";
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
        <span className="text-xs font-semibold text-ink/70">Discussion</span>
        <Count n={d?.commentCount} />
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
      {d && !canComment(user, d.repo) ? (
        <p className={compact ? "mt-4 flex items-center gap-2 text-xs text-ink/50" : "flex items-center gap-2 border-t border-line p-3 text-xs text-ink/50"}>
          <LockIcon className="shrink-0" /> You can read this discussion but not comment.
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
          placeholder="Comment for maintainers (not posted on GitHub)"
          aria-label="Comment"
          className="block w-full resize-none rounded border border-line bg-sunken px-2.5 py-2 text-sm outline-none placeholder:text-ink/40 focus:border-accent/60"
        />
        <div className="mt-2 flex items-center justify-between">
          {!compact && (
            <span className="flex items-center gap-1 text-xs text-ink/45">
              <Kbd keys="Ctrl ↵" /> to send
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
