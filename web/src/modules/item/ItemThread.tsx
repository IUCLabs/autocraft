// The item page as one thread, oldest first: the description, GitHub comments, operator messages and Opus turns,
// with runs of pipeline events folded between them, then the open question and the composer.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { CheckCircleIcon, PlusCircleIcon, SpinnerIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useApi, useQuery, usePagedQuery } from "../../api/client";
import type { ConversationTurn, Decision, Item, ItemTrace, TraceEvent, TraceKind } from "../../api/types";
import { Avatar } from "../../ui/atoms/Avatar";
import { Button } from "../../ui/atoms/Button";
import { ErrorLine } from "../../ui/atoms/ErrorLine";
import { TimeAgo } from "../../ui/atoms/TimeAgo";
import { ChatEntry } from "../../ui/molecules/ChatEntry";
import { Collapsible, Markdown } from "../../ui/molecules/Markdown";
import { PipelineRun } from "../../ui/molecules/PipelineRun";
import { TraceFilters } from "../../ui/molecules/TraceFilters";
import { TraceHeader } from "../../ui/organisms/TraceHeader";
import { useUser } from "../../shell/UserContext";
import { canAct, canComment } from "../../registry/permissions";
import { useNow } from "../../lib/useNow";
import { localActions } from "../decisions/state";
import { ActionCard, Progress } from "./OpusCards";
import { Composer } from "./Composer";
import { OpenQuestions, useItemDecisions } from "./ItemDecisions";
import { PipelineRows, hashEvent } from "./PipelineRows";

const PAGE = 50;
const dedupe = (events: TraceEvent[]) => {
  const seen = new Set<string>();
  return events.filter((e) => !seen.has(e.id) && seen.add(e.id));
};

type Entry =
  | { t: "event"; e: TraceEvent; at: number }
  | { t: "turn"; turn: ConversationTurn; at: number }
  | { t: "feedback"; f: Feedback; at: number }
  | { t: "more"; at: number };

/** A maintainer's or operator's post on one of the item's decisions: a pick with its note, or plain text. */
type Feedback = { id: string; source: string; login: string; role: "maintainer" | "operator"; text: string | null; pick: string | null; write: boolean; d: Decision; at: string };

const isChat = (e: TraceEvent) => e.kind === "github" && e.body !== undefined;
const ms = (iso: string) => Date.parse(iso);

/**
 * The trace request starts from the route's repo and number, beside the item request. The thread shows once
 * the item is there too, so the header never pushes it down.
 */
export function ItemThread({ repo, number, it, decision, onAnswered }: {
  repo: string;
  number: number;
  it?: Item;
  /** The decision page's own decision: it comes first at the end of the thread, the trace header is left out. */
  decision?: Decision;
  onAnswered?: () => void;
}) {
  useNow();
  const user = useUser();
  const [kinds, setKinds] = useState<TraceKind[]>([]);
  const [autocraftOnly, setAutocraftOnly] = useState(false);
  const key = `item-trace:${repo}#${number}:${[...kinds].sort().join(",")}|${autocraftOnly ? 1 : 0}`;

  // Oldest first: a change event refetches every loaded page in order, so new events append at the bottom and "Load more" keeps its place.
  const q = usePagedQuery<ItemTrace>(
    key,
    async (a, cursor) => {
      const r = await a.itemTrace(repo, number, { kinds: kinds.length ? kinds : undefined, autocraftOnly, limit: PAGE, cursor });
      if ("unchanged" in r) throw new Error("unexpected empty answer");
      return r;
    },
    (p) => p.nextCursor,
  );
  const { data: conv } = useQuery(`conversation:${repo}#${number}`, (a) => a.conversations.get(repo, number), { pollMs: (d) => (d?.pending ? 4000 : false) });
  const { data: listed } = useItemDecisions(repo, number);
  const ds = listed && decision ? [decision, ...listed.filter((d) => d.id !== decision.id)] : decision ? [decision] : listed;
  const ids = ds?.map((d) => d.id).join(",") ?? "";
  const { data: threads } = useQuery(
    `thread:item:${repo}#${number}:${ids}`,
    async (a) => Object.fromEntries(await Promise.all((ds ?? []).map(async (d) => [d.id, await a.decisions.thread(d.id)] as const))),
    { enabled: !!ds },
  );
  const first = q.pages?.[0];
  const events = q.pages ? dedupe(q.pages.flatMap((p) => p.events)) : [];

  const [open, setOpen] = useState<Set<string>>(() => {
    const id = hashEvent();
    return new Set(id ? [id] : []);
  });
  const toggle = (id: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (!n.delete(id)) n.add(id);
      return n;
    });

  // A link with #event=<id> opens that row and scrolls to it once the row exists.
  const scrolled = useRef(false);
  useEffect(() => {
    const id = hashEvent();
    if (!id || scrolled.current) return;
    if (!events.some((e) => e.id === id)) {
      if (q.hasMore && !q.loadingMore) q.loadMore();
      return;
    }
    scrolled.current = true;
    document.getElementById(`event-${id}`)?.scrollIntoView({ block: "start" });
  }, [events, q.hasMore, q.loadingMore]);

  if (!it) return null;
  if (!first) return q.error ? <ErrorLine error={q.error.message} className="mt-4" /> : <div className="mt-4 h-24" aria-hidden />;

  const operator = canAct(user, [it.repo]);
  const openDecisions = ds?.filter((d) => !d.answer) ?? [];
  const turns = conv?.turns ?? [];
  // The newest Opus turn's cards move to the open question while one is open, so they appear once.
  const lastOpus = [...turns].reverse().find((t) => t.kind === "opus");
  const hoisted = openDecisions.length > 0 && lastOpus && lastOpus.actions.length > 0 ? lastOpus : undefined;

  // The author's role comes from the write access recorded with their pick; plain comments take it from a pick of the same person.
  const writers = new Set((ds ?? []).flatMap((d) => d.opinions.filter((o) => o.permission === "write").map((o) => o.login)));
  const feedback: Feedback[] = (ds ?? []).flatMap((d) => [
    ...d.opinions.map((o): Feedback => ({ id: `opinion:${o.id}`, source: `decision-opinion:${o.id}`, login: o.login, role: o.permission === "write" ? "operator" : "maintainer", text: o.note, pick: o.option, write: o.permission === "write", d, at: o.at })),
    ...(threads?.[d.id] ?? []).map((c): Feedback => ({ id: `comment:${c.id}`, source: `decision-comment:${c.id}`, login: c.login, role: writers.has(c.login) ? "operator" : "maintainer", text: c.body, pick: null, write: false, d, at: c.at })),
  ]);
  const entries: Entry[] = [
    ...feedback.map((f): Entry => ({ t: "feedback", f, at: ms(f.at) })),
    ...events.filter((e) => e.kind !== "conversation").map((e): Entry => ({ t: "event", e, at: ms(e.at) })),
    ...turns.map((turn): Entry => ({ t: "turn", turn, at: ms(turn.at) })),
  ];
  if (q.hasMore && events.length) entries.push({ t: "more", at: ms(events[events.length - 1]!.at) + 0.5 });
  entries.sort((a, b) => a.at - b.at);

  const list: ReactNode[] = [];
  let run: TraceEvent[] = [];
  const flush = () => {
    if (!run.length) return;
    const evs = run;
    run = [];
    const rows = <PipelineRows events={evs} all={events} item={it} open={open} toggle={toggle} />;
    if (evs.length < 2) {
      list.push(<li key={`run:${evs[0]!.id}`} className="list-none overflow-hidden rounded-md border border-line">{rows}</li>);
      return;
    }
    const rid = `run:${evs[0]!.id}`;
    const target = hashEvent();
    const names = [...new Set(evs.map((e) => e.actor.name))];
    list.push(
      <PipelineRun
        key={rid}
        id={rid}
        count={evs.length}
        from={<>{names.slice(0, 3).join(", ")}{names.length > 3 ? ` and ${names.length - 3} more` : ""} · <TimeAgo iso={evs[evs.length - 1]!.at} /></>}
        open={open.has(rid) || (!!target && evs.some((e) => e.id === target))}
        onToggle={() => toggle(rid)}
      >
        {rows}
      </PipelineRun>,
    );
  };
  for (const en of entries) {
    if (en.t === "event" && !isChat(en.e)) {
      run.push(en.e);
      continue;
    }
    flush();
    if (en.t === "more")
      list.push(
        <li key="more" className="list-none">
          <Button size="sm" disabled={q.loadingMore} onClick={q.loadMore} className="max-md:h-11">
            Load more
          </Button>
        </li>,
      );
    else if (en.t === "feedback") list.push(<FeedbackPost key={en.f.id} f={en.f} repo={it.repo} number={it.number} include={conv?.includes.find((x) => x.source === en.f.source)} operator={operator} me={user.login} commenter={canComment(user)} />);
    else if (en.t === "event")
      list.push(
        <ChatEntry key={en.e.id} id={en.e.id} author={en.e.actor.name} at={en.e.at} tag={en.e.kind === "github" && /review/i.test(en.e.summary) ? "Review" : undefined}>
          <Collapsible lines={25}>
            <Markdown source={en.e.body!} />
          </Collapsible>
          {en.e.bodyCut && <p className="mt-2 text-xs text-ink/55">Cut after 20,000 characters. The rest is on GitHub.</p>}
        </ChatEntry>,
      );
    else list.push(<Turn key={`turn:${en.turn.id}`} t={en.turn} operator={operator} withCards={en.turn !== hoisted} />);
  }
  flush();

  const cards = hoisted && (
    <>
      {[...hoisted.actions].sort((a, b) => Number(b.settles !== undefined) - Number(a.settles !== undefined)).map((a) => (
        <ActionCard key={a.id} a={a} operator={operator} className="" />
      ))}
    </>
  );
  return (
    <>
      {!decision && <TraceHeader header={first.header} decisionHref={(id) => `/needs/decisions/${encodeURIComponent(id)}`} />}
      <section className="mt-6" aria-label="Thread">
        <TraceFilters kinds={kinds} onKinds={setKinds} autocraftOnly={autocraftOnly} onAutocraftOnly={setAutocraftOnly} />
        <ol className="mt-3 space-y-3">
          {it.body && (
            <ChatEntry author={it.author} at={it.createdAt} tag="Description">
              <Collapsible lines={25}>
                <Markdown source={it.body} />
              </Collapsible>
            </ChatEntry>
          )}
          {list}
          {conv?.pending && (
            <li className="list-none text-sm text-ink/55">
              <div className="flex items-center gap-2">
                <Avatar login="opus" size={20} />
                <SpinnerIcon className="animate-spin text-ink/45" />
                Opus is replying…
              </div>
              <Progress lines={conv.progress} />
            </li>
          )}
        </ol>
        {list.length === 0 && !it.body && <p className="text-sm text-ink/55">No events match.</p>}
        <ErrorLine error={q.error?.message} className="mt-2" />
      </section>
      <OpenQuestions ds={ds ?? []} focus={decision} cards={cards} onAnswered={onAnswered} />
      <Composer
        repo={it.repo}
        number={it.number}
        operator={operator}
        commenter={canComment(user)}
        exists={!!conv?.exists}
        pending={!!conv?.pending}
        feedbackOn={decision && !decision.answer ? decision : openDecisions[0]}
      />
    </>
  );
}

function Turn({ t, operator, withCards }: { t: ConversationTurn; operator: boolean; withCards: boolean }) {
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
      {withCards && t.actions.length > 0 && (
        <div className="mt-3 space-y-2">
          {t.actions.map((a) => (
            <ActionCard key={a.id} a={a} operator={operator} className="" />
          ))}
        </div>
      )}
    </ChatEntry>
  );
}

function FeedbackPost({ f, repo, number, include, operator, me, commenter }: { f: Feedback; repo: string; number: number; include?: { sent: boolean }; operator: boolean; me: string; commenter: boolean }) {
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
  const label = f.pick ? (f.d.options.find((o) => o.key === f.pick)?.label ?? f.pick) : null;
  const open = !f.d.answer;
  return (
    <ChatEntry id={f.id} author={f.login === me ? "You" : f.login} at={f.at} tag={f.role === "operator" ? "Operator" : "Maintainer"}>
      {label && (
        <p className="text-ink/60">
          Suggests <span className="font-medium text-ink">{label}</span>
        </p>
      )}
      {f.text && <p className={`whitespace-pre-wrap break-words ${label ? "mt-1" : ""}`}>{f.text}</p>}
      {operator && f.login !== me && (
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
      {error && <p className="mt-1 text-xs text-bad">{error}</p>}
      {open && ((f.pick && f.login === me && commenter) || (operator && f.pick && f.write)) && (
        <div className="mt-2 flex flex-wrap gap-3">
          {f.pick && f.login === me && commenter && (
            <button onClick={() => void api.decisions.retract(f.d.id)} className="text-xs text-accent-ink hover:underline max-md:min-h-11">
              Retract
            </button>
          )}
          {operator && f.pick && f.write && (
            <button onClick={() => localActions.setPick(f.d.id, f.pick!)} className="rounded border border-line-strong px-2 py-0.5 text-xs font-medium hover:border-accent/60 hover:text-accent-ink max-md:min-h-11">
              Use this answer
            </button>
          )}
        </div>
      )}
    </ChatEntry>
  );
}
