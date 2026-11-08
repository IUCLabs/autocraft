import { useState } from "react";
import { CheckCircleIcon, PlusCircleIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useApi, useQuery } from "../../api/client";
import type { Conversation as ConversationData, ConversationTurn, Decision } from "../../api/types";
import { Badge } from "../../ui/atoms/Badge";
import { ErrorLine } from "../../ui/atoms/ErrorLine";
import { TimeAgo } from "../../ui/atoms/TimeAgo";
import { ChatEntry } from "../../ui/molecules/ChatEntry";
import { Markdown } from "../../ui/molecules/Markdown";
import { OpusWorking } from "../../ui/molecules/OpusWorking";
import { useUser } from "../../shell/UserContext";
import { canAct, canComment } from "../../registry/permissions";
import { canActOn } from "../decisions/access";
import { localActions } from "../decisions/state";
import { ActionCard, Progress } from "./OpusCards";

/** A maintainer's or operator's post on one of the item's decisions: a pick with its note, or plain text. */
type Feedback = { id: string; source: string; login: string; role: "maintainer" | "operator"; text: string | null; pick: string | null; write: boolean; d: Decision; at: string; viaAgent: boolean };
type Entry = { t: "turn"; turn: ConversationTurn; at: number } | { t: "feedback"; f: Feedback; at: number };
const ms = (iso: string) => Date.parse(iso);

/**
 * The conversation of one item: Opus's turns and the feedback posted on its decisions (with the operator's include/exclude for Opus), oldest first,
 * then the actions Opus suggests as replies and, while Opus is replying, its progress.
 */
export function Conversation({ repo, number, conv, ds, updating }: { repo: string; number: number; conv: ConversationData; ds: Decision[]; updating: boolean }) {
  const user = useUser();
  const ids = ds.map((d) => d.id).join(",");
  const { data: threads } = useQuery(`thread:item:${repo}#${number}:${ids}`, async (a) => Object.fromEntries(await Promise.all(ds.map(async (d) => [d.id, await a.decisions.thread(d.id)] as const))), { enabled: ds.length > 0 });
  const operator = user.role === "operator" && canAct(user, [repo]);
  // The author's role comes from the write access recorded with their pick; plain comments take it from a pick of the same person.
  const writers = new Set(ds.flatMap((d) => d.opinions.filter((o) => o.permission === "write").map((o) => o.login)));
  const feedback: Feedback[] = ds.flatMap((d) => [
    ...d.opinions.map((o): Feedback => ({ id: `opinion:${o.id}`, source: `decision-opinion:${o.id}`, login: o.login, role: o.permission === "write" ? "operator" : "maintainer", text: o.note, pick: o.option, write: o.permission === "write", d, at: o.at, viaAgent: o.via === "mcp" })),
    ...(threads?.[d.id] ?? []).map((c): Feedback => ({ id: `comment:${c.id}`, source: `decision-comment:${c.id}`, login: c.login, role: writers.has(c.login) ? "operator" : "maintainer", text: c.body, pick: null, write: false, d, at: c.at, viaAgent: c.via === "mcp" })),
  ]);
  const entries: Entry[] = [...feedback.map((f): Entry => ({ t: "feedback", f, at: ms(f.at) })), ...conv.turns.map((turn): Entry => ({ t: "turn", turn, at: ms(turn.at) }))].sort((a, b) => a.at - b.at);
  // Only the newest Opus turn's cards are live. A card that leaves the question open is a suggested reply; cards run from choices are not.
  const lastOpus = [...conv.turns].reverse().find((t) => t.kind === "opus");
  const suggestions = lastOpus?.actions.filter((a) => a.settles === undefined && !a.fromChoice && ["proposed", "running", "failed"].includes(a.state) && a.canSettle) ?? [];
  return (
    <>
      <ol className="space-y-2.5">
        {entries.map((en) => (en.t === "turn" ? <Turn key={`turn:${en.turn.id}`} t={en.turn} /> : <FeedbackPost key={en.f.id} f={en.f} repo={repo} number={number} include={conv.includes.find((x) => x.source === en.f.source)} operator={operator} settle={canActOn(user, [en.f.d])} me={user.login} commenter={canComment(user)} />))}
        {conv.pending && (
          <li className="list-none">
            <OpusWorking text="Opus is replying…">
              <Progress lines={conv.progress} />
            </OpusWorking>
          </li>
        )}
      </ol>
      {!updating && suggestions.length > 0 && (
        <div className="mt-3 space-y-2">
          {suggestions.map((a) => (
            <ActionCard key={a.id} a={a} operator={canAct(user, [repo])} editInstructions={user.role === "operator"} className="" item={{ repo, number }} />
          ))}
        </div>
      )}
    </>
  );
}

function Turn({ t }: { t: ConversationTurn }) {
  if (t.kind === "system")
    return (
      <li className="flex list-none items-start gap-2 px-1 text-xs text-ink/50">
        <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-ink/30" />
        <span className="min-w-0 flex-1">{t.body}</span>
        <span className="shrink-0"><TimeAgo iso={t.at} /></span>
      </li>
    );
  const opus = t.kind === "opus";
  return (
    <ChatEntry id={`turn:${t.id}`} author={opus ? "Opus" : t.login} at={t.at} tone={opus ? "ours" : "person"}>
      {opus ? <Markdown source={t.body} /> : <p className="whitespace-pre-wrap">{t.body}</p>}
      {t.status === "failed" && (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-bad">
          <WarningCircleIcon className="mt-0.5 shrink-0" />
          {t.error ?? "Opus gave no usable reply."}
        </p>
      )}
      {t.notes.map((n, i) => (
        <p key={i} className="mt-1 text-xs text-ink/50">{n}</p>
      ))}
    </ChatEntry>
  );
}

function FeedbackPost({ f, repo, number, include, operator, settle, me, commenter }: { f: Feedback; repo: string; number: number; include?: { sent: boolean }; operator: boolean; settle: boolean; me: string; commenter: boolean }) {
  const api = useApi();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const flip = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await api.conversations.include(repo, number, f.source, !include);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const retract = async () => {
    setError(undefined);
    try {
      await api.decisions.retract(f.d.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const label = f.pick ? (f.d.options.find((o) => o.key === f.pick)?.label ?? f.pick) : null;
  const open = !f.d.answer;
  return (
    <ChatEntry id={f.id} author={f.login === me ? "You" : f.login} at={f.at} tag={<>{f.viaAgent && <Badge className="mr-2">via agent</Badge>}{f.role === "operator" ? "Operator" : "Maintainer"}</>}>
      {label && (
        <p className="text-ink/60">
          Suggests <span className="font-medium text-ink">{label}</span>
        </p>
      )}
      {f.text && <p className={`whitespace-pre-wrap break-words ${label ? "mt-1" : ""}`}>{f.text}</p>}
      {operator && f.login !== me && (f.d.number !== null || (!!f.pick && !f.text)) && (
        <button
          onClick={() => void flip()}
          disabled={busy || include?.sent}
          aria-pressed={!!include}
          className={`mt-2 inline-flex min-h-8 items-center gap-1.5 rounded border px-2 text-xs font-medium transition-colors duration-fast disabled:opacity-60 max-md:min-h-11 ${include ? "border-accent/50 bg-accent/[0.08] text-accent-ink" : "border-line-strong text-ink/70 hover:bg-ink/[0.05]"}`}
        >
          {include ? <CheckCircleIcon className="text-[14px]" /> : <PlusCircleIcon className="text-[14px]" />}
          {include?.sent ? "Sent to Opus" : include ? "Included" : "Include for Opus"}
        </button>
      )}
      <ErrorLine error={error} className="mt-1 text-xs" />
      {open && ((f.pick && f.login === me && commenter) || (settle && f.pick && f.write)) && (
        <div className="mt-2 flex flex-wrap gap-3">
          {f.pick && f.login === me && commenter && (
            <button onClick={() => void retract()} className="text-xs text-accent-ink hover:underline max-md:min-h-11">
              Retract
            </button>
          )}
          {settle && f.pick && f.write && (
            <button onClick={() => localActions.setPick(f.d.id, f.pick!)} className="rounded border border-line-strong px-2 py-0.5 text-xs font-medium hover:border-accent/60 hover:text-accent-ink max-md:min-h-11">
              Use this answer
            </button>
          )}
        </div>
      )}
    </ChatEntry>
  );
}
