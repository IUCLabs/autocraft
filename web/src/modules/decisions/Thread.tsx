import { useState } from "react";
import { useApi, useQuery } from "../../api/client";
import type { ViewProps } from "../../registry/types";
import { Avatar } from "../../ui/Avatar";
import { Button } from "../../ui/Button";
import { Count } from "../../ui/Heading";
import { Kbd } from "../../ui/Kbd";
import { ago } from "../../lib/format";
import { localActions, refOf, useDecisionList, useSelection } from "./state";
import { OpinionList } from "./parts";
import { decisionAccess } from "../../registry/permissions";

/** Desktop side panel: everyone's opinions (operators adopt from here), then the comment thread. */
export function ThreadPanel({ user }: ViewProps) {
  const api = useApi();
  const { id } = useSelection();
  const { data } = useDecisionList();
  const d = data?.decisions.find((x) => x.id === id);
  const operator = d ? decisionAccess(user, d.items.length ? d.items.map((i) => i.repo) : [d.repo]).mode === "answer" : false;
  const adopt = async (oid: string) => {
    if (!d) return;
    const o = d.opinions.find((x) => x.id === oid);
    await api.decisions.adopt(d.id, oid);
    localActions.answered([{ id: d.id, ref: refOf(d), label: d.options.find((x) => x.key === o?.option)?.label ?? "" }]);
  };
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-4 pr-10">
        <span className="text-xs font-semibold text-ink/70">Opinions and discussion</span>
      </div>
      {d ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <section className="border-b border-line p-3">
            <h2 className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-ink/60">
              Opinions <Count n={d.opinions.length} />
              {d.opinions.length > 0 && <span className="ml-auto font-normal text-ink/45">not sent to the pipeline</span>}
            </h2>
            <OpinionList d={d} me={user.login} onAdopt={operator && !d.answer ? (oid) => void adopt(oid) : undefined} />
          </section>
          <h2 className="flex items-center gap-1.5 px-4 pt-3 text-xs font-semibold text-ink/60">
            Discussion <Count n={d.commentCount} />
          </h2>
          <Thread decisionId={d.id} />
        </div>
      ) : (
        <p className="p-4 text-sm text-ink/50">No decision selected.</p>
      )}
    </div>
  );
}

export function Thread({ decisionId, compact }: { decisionId: string; compact?: boolean }) {
  const api = useApi();
  const { data } = useQuery(`thread:${decisionId}`, (a) => a.decisions.thread(decisionId));
  const { data: list } = useDecisionList();
  const d = list?.decisions.find((x) => x.id === decisionId);
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
      <div className={compact ? "mt-4" : "border-t border-line p-3"}>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
            if (e.key === "Escape") e.currentTarget.blur();
          }}
          rows={compact ? 2 : 3}
          placeholder="Comment (not posted on GitHub)"
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
    </div>
  );
}
