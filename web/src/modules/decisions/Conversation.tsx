import { useState } from "react";
import { CheckIcon, PaperPlaneRightIcon, SpinnerIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useApi, useQuery } from "../../api/client";
import type { ConversationCard, ConversationTurn, RepoName } from "../../api/types";
import { Avatar } from "../../ui/atoms/Avatar";
import { Button } from "../../ui/atoms/Button";
import { Markdown } from "../../ui/molecules/Markdown";
import {  } from "../../lib/format";
import { TimeAgo } from "../../ui/atoms/TimeAgo";
import { useNow } from "../../lib/useNow";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The Opus conversation of one item: turns, Opus's action cards and, for operators, the reply box. */
export function Conversation({ repo, number, operator }: { repo: RepoName; number: number; operator: boolean }) {
  useNow();
  const api = useApi();
  const { data: c } = useQuery(`conversation:${repo}#${number}`, (a) => a.conversations.get(repo, number), { pollMs: (d) => (d?.pending ? 4000 : false) });
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();

  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setError(undefined);
    try {
      await api.conversations.say(repo, number, text);
      setDraft("");
    } catch (e) {
      setError(message(e));
    } finally {
      setSending(false);
    }
  };

  if (!c) return <p className="text-sm text-ink/45">Loading…</p>;
  return (
    <div>
      {c.turns.length === 0 && <p className="text-sm text-ink/45">No conversation yet.</p>}
      <ol className="space-y-4">
        {c.turns.map((t) => (
          <Turn key={t.id} t={t} operator={operator} />
        ))}
        {c.pending && (
          <li className="text-sm text-ink/55">
            <div className="flex items-center gap-2">
              <Avatar login="opus" size={20} />
              <SpinnerIcon className="animate-spin text-ink/45" />
              Opus is replying…
            </div>
            <Progress lines={c.progress} />
          </li>
        )}
      </ol>
      {operator && (
        <div className="mt-4">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
            }}
            rows={2}
            placeholder={c.exists ? "Reply to Opus" : "Ask Opus about this item"}
            aria-label="Message to Opus"
            className="block w-full resize-none rounded border border-line bg-sunken px-2.5 py-2 text-sm outline-none placeholder:text-ink/40 focus:border-accent/60"
          />
          {error && <p className="mt-1.5 text-xs text-bad">{error}</p>}
          <div className="mt-2 flex justify-end">
            <Button size="sm" variant="secondary" className="max-md:h-11" icon={PaperPlaneRightIcon} disabled={!draft.trim() || sending || c.pending} onClick={() => void send()}>
              Reply
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function Turn({ t, operator }: { t: ConversationTurn; operator: boolean }) {
  if (t.kind === "system") {
    return (
      <li className="flex items-start gap-2 text-xs text-ink/50">
        <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-ink/30" />
        <span className="min-w-0 flex-1">{t.body}</span>
        <span className="shrink-0"><TimeAgo iso={t.at} /></span>
      </li>
    );
  }
  return (
    <li className="animate-fadeIn">
      <div className="flex items-center gap-2">
        <Avatar login={t.login} size={20} />
        <span className="text-sm font-semibold">{t.kind === "opus" ? "Opus" : t.login}</span>
        <span className="ml-auto text-xs text-ink/45"><TimeAgo iso={t.at} /></span>
      </div>
      <div className="mt-1 pl-7 text-sm leading-5 text-ink/80">
        {t.kind === "opus" ? <Markdown source={t.body} /> : <p className="whitespace-pre-wrap">{t.body}</p>}
      </div>
      {t.status === "failed" && (
        <p className="mt-1 flex items-start gap-1.5 pl-7 text-xs text-bad">
          <WarningCircleIcon className="mt-0.5 shrink-0" />
          {t.error ?? "Opus gave no usable reply."}
        </p>
      )}
      {t.notes.map((n, i) => (
        <p key={i} className="mt-1 pl-7 text-xs text-ink/50">
          {n}
        </p>
      ))}
      {t.actions.map((a) => (
        <ActionCard key={a.id} a={a} operator={operator} />
      ))}
    </li>
  );
}

function ActionCard({ a, operator }: { a: ConversationCard; operator: boolean }) {
  const api = useApi();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(a.text ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // An answer that writes to GitHub needs a second press, like the decision page.
  const [armed, setArmed] = useState(false);
  const proposed = a.state === "proposed";

  const act = async (f: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await f();
      setEditing(false);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const run = () => {
    if (a.writes && !armed) return setArmed(true);
    setArmed(false);
    return act(async () => {
      if (editing && text !== a.text) await api.conversations.editCard(a.id, text);
      await api.conversations.doCard(a.id);
    });
  };

  return (
    <div className={`ml-7 mt-2 rounded-md border border-line-strong px-3 py-2.5 ${a.state === "dismissed" ? "bg-transparent" : "bg-raised"}`}>
      <div className="flex items-center gap-1.5 text-sm font-medium">
        {a.state === "done" && <CheckIcon className="shrink-0 text-ok" />}
        {a.state === "failed" && <WarningCircleIcon className="shrink-0 text-bad" />}
        {a.state === "running" && <SpinnerIcon className="shrink-0 animate-spin text-ink/50" />}
        <span className={`min-w-0 flex-1 ${a.state === "dismissed" ? "font-normal text-ink/45 line-through" : ""}`}>{a.title}</span>
        {a.state === "done" && <span className="shrink-0 text-xs font-normal text-ok">Done</span>}
        {a.state === "failed" && <span className="shrink-0 text-xs font-normal text-bad">Failed</span>}
        {a.state === "running" && <span className="shrink-0 text-xs font-normal text-ink/55">Running…</span>}
        {a.state === "dismissed" && <span className="shrink-0 text-xs font-normal text-ink/45">Dismissed</span>}
      </div>
      {a.text !== undefined && a.state !== "dismissed" &&
        (editing ? (
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={5}
            aria-label="Comment text"
            className="mt-2 block w-full resize-none rounded border border-line bg-sunken px-2.5 py-2 text-sm leading-5 outline-none focus:border-accent/60"
          />
        ) : (
          <blockquote className="mt-2 whitespace-pre-wrap border-l-2 border-line-strong pl-3 text-sm leading-5 text-ink/75">{a.text}</blockquote>
        ))}
      {a.state === "failed" && a.error && <p className="mt-2 text-xs text-bad">{a.error}</p>}
      {a.state === "done" && a.done && (
        <p className="mt-2 text-xs text-ink/55">
          {a.done.link ? (
            <a href={a.done.link} target="_blank" rel="noreferrer" className="text-accent-ink hover:underline">
              {a.done.label}
            </a>
          ) : (
            a.done.label
          )}{" "}
          · <TimeAgo iso={a.done.at} />
          {a.by ? ` · ${a.by}` : ""}
        </p>
      )}
      {error && <p className="mt-2 text-xs text-bad">{error}</p>}
      {proposed && operator && (
        <div className="mt-2.5 flex items-center gap-2">
          <Button
            size="sm"
            variant="primary"
            className={`max-md:h-11 ${armed ? "border-bad bg-bad text-white hover:bg-bad/90" : ""}`}
            disabled={busy}
            onClick={() => void run()}
          >
            {armed ? `Confirm: ${a.writes}` : a.label}
          </Button>
          {armed && (
            <Button size="sm" variant="ghost" className="max-md:h-11" disabled={busy} onClick={() => setArmed(false)}>
              Cancel
            </Button>
          )}
          {editing ? (
            <Button size="sm" variant="ghost" className="max-md:h-11" disabled={busy} onClick={() => { setEditing(false); setText(a.text ?? ""); }}>
              Cancel
            </Button>
          ) : (
            a.text !== undefined && (
              <Button size="sm" variant="secondary" className="max-md:h-11" disabled={busy} onClick={() => setEditing(true)}>
                Edit
              </Button>
            )
          )}
          <Button size="sm" variant="ghost" className="max-md:h-11" disabled={busy} onClick={() => void act(() => api.conversations.dismissCard(a.id))}>
            Dismiss
          </Button>
        </div>
      )}
    </div>
  );
}

/** What Opus did last, in a quiet line; the few before it show on hover or focus. Plain text only: the lines come from model-written tool inputs. */
function Progress({ lines }: { lines?: string[] }) {
  if (!lines?.length) return null;
  const last = lines[lines.length - 1]!;
  return (
    <div className="group ml-[28px] mt-0.5 text-xs text-ink/40" tabIndex={0} aria-live="off">
      <p className="truncate" title={lines.join("\n")}>{last}</p>
      {lines.length > 1 && (
        <ul className="hidden group-hover:block group-focus:block">
          {lines.slice(0, -1).reverse().map((l, i) => (
            <li key={`${lines.length - 2 - i}:${l}`} className="truncate text-ink/30">{l}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
