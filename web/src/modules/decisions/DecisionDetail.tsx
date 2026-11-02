import { useEffect, useRef, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ChevronLeftIcon, ChevronRightIcon, CheckIcon, Undo2Icon, MessageSquareIcon, InboxIcon, SparklesIcon, ArrowDownIcon } from "lucide-react";
import { useApi } from "../../api/client";
import type { Decision, User } from "../../api/types";
import type { ViewProps } from "../../registry/types";
import { decisionAccess, type DecisionAccess } from "../../registry/permissions";
import { Kbd } from "../../ui/Kbd";
import { Button, IconButton } from "../../ui/Button";
import { Count } from "../../ui/Heading";
import { Markdown, Collapsible } from "../../ui/Markdown";
import { cn } from "../../ui/cn";
import { ago } from "../../lib/format";
import { ClaimPill, ClassifierLines, Disclosure, Facts, KindTag, OpinionList, OptionButtons, RelatedList, tallyOf } from "./parts";
import { localActions, ordered, refOf, useAnswer, useDecisionList, useLocal, useSelection, useUndo } from "./state";
import { Thread } from "./Thread";

export const accessFor = (user: User, ds: Decision[]): DecisionAccess =>
  decisionAccess(user, ds.flatMap((d) => (d.items.length ? d.items.map((i) => i.repo) : [d.repo])));

/** Desktop detail panel: the selected decision, or the batch answer for checked rows. */
export function DetailPanel({ user }: ViewProps) {
  const { data } = useDecisionList();
  const { id, go } = useSelection();
  const loc = useLocal();
  const list = ordered(data?.decisions ?? []);
  const checked = list.filter((d) => loc.checked.has(d.id));

  if (checked.length > 1) return <MultiAnswer ds={checked} user={user} />;
  const d = list.find((x) => x.id === id) ?? null;
  const idx = d ? list.indexOf(d) : -1;
  const just = loc.justAnswered.find((x) => x.id === id);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-4 pr-10 text-xs text-ink/55">
        {data && d && (
          <span className="num">
            {idx + 1} of {list.length}
          </span>
        )}
        <div className="ml-auto flex items-center">
          <IconButton size="sm" icon={ChevronLeftIcon} label="Previous (k)" disabled={idx <= 0} onClick={() => go(list[idx - 1]?.id)} />
          <IconButton size="sm" icon={ChevronRightIcon} label="Next (j)" disabled={idx < 0 || idx >= list.length - 1} onClick={() => go(list[idx + 1]?.id)} />
        </div>
      </div>
      {just && !d ? (
        <AnsweredNotice entry={just} />
      ) : d ? (
        <DecisionBody key={d.id} d={d} user={user} onAnswered={() => go(list[idx + 1]?.id ?? list[idx - 1]?.id)} />
      ) : (
        <EmptyDetail count={list.length} />
      )}
    </div>
  );
}

function EmptyDetail({ count }: { count: number }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
      <InboxIcon className="text-[28px] text-ink/25" />
      {count === 0 ? (
        <>
          <p className="text-md font-semibold">Nothing waiting</p>
          <p className="text-sm text-ink/55">Every decision in this view has an answer.</p>
        </>
      ) : (
        <p className="text-sm text-ink/55">
          Select a decision. <Kbd keys="j" /> and <Kbd keys="k" /> move through the list.
        </p>
      )}
    </div>
  );
}

function AnsweredNotice({ entry }: { entry: { id: string; label: string; ref: string } }) {
  const undo = useUndo();
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="flex items-center gap-3 rounded-md border border-line px-4 py-2.5 text-sm">
        <CheckIcon className="text-ok" />
        <span className="code">{entry.ref}</span>
        <span className="text-ink/70">→ {entry.label}</span>
        <Button size="sm" variant="ghost" icon={Undo2Icon} onClick={() => undo(entry.id)}>
          Undo
        </Button>
      </div>
    </div>
  );
}

function Section({ title, aside, children }: { title: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="mt-5">
      <h2 className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-ink/60">
        {title}
        {aside && <span className="ml-auto font-normal text-ink/45">{aside}</span>}
      </h2>
      {children}
    </section>
  );
}

/**
 * The decision: the item first (AI summary, then its description), then facts,
 * opinions and the question. Shared by the desktop detail panel and the phone pager;
 * it owns its scroll container so the decision bar can stay pinned.
 */
export function DecisionBody({
  d,
  user,
  onAnswered,
  phone,
  pager,
}: {
  d: Decision;
  user: User;
  onAnswered?: () => void;
  phone?: boolean;
  /** Phone only: previous/next in the queue, shown in the bottom bar. */
  pager?: { pos: string; prev?: () => void; next?: () => void };
}) {
  const api = useApi();
  const answer = useAnswer();
  const loc = useLocal();
  const noteRef = useRef<HTMLInputElement>(null);
  const decideRef = useRef<HTMLDivElement>(null);
  const access = accessFor(user, [d]);
  const isBatch = d.number === null;
  const mine = d.opinions.find((o) => o.login === user.login);
  const tally = tallyOf(d);
  const operator = access.mode === "answer";

  useEffect(() => {
    if (!d.answer) void api.decisions.claim(d.id);
  }, [api, d.id, d.answer]);

  const pick = async (key: string) => {
    if (!operator) {
      await api.decisions.opine(d.id, { option: key, note: loc.notes[d.id] || mine?.note || undefined });
      localActions.setNote(d.id, "");
      return;
    }
    await answer([d], key);
    onAnswered?.();
  };
  const adopt = async (oid: string) => {
    const o = d.opinions.find((x) => x.id === oid);
    await api.decisions.adopt(d.id, oid);
    localActions.answered([{ id: d.id, ref: refOf(d), label: d.options.find((x) => x.key === o?.option)?.label ?? "" }]);
    onAnswered?.();
  };

  // Number keys pick; n focuses the note. Bound here so they always target the decision on screen.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (["INPUT", "TEXTAREA"].includes(t.tagName) || e.metaKey || e.ctrlKey || e.altKey) return;
      const n = Number(e.key);
      if (!d.answer && n >= 1 && n <= d.options.length) {
        e.preventDefault();
        void pick(d.options[n - 1].key);
      }
      if (e.key === "n" && noteRef.current) {
        e.preventDefault();
        noteRef.current.focus();
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  });

  const modeLine = operator ? (
    <>Your pick answers it.</>
  ) : (
    <>
      {access.reason}
      {mine && (
        <button onClick={() => void api.decisions.retract(d.id)} className="ml-1.5 text-accent-ink hover:underline">
          Retract mine
        </button>
      )}
    </>
  );

  const note = (
    <label className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded border border-line bg-sunken px-2.5 focus-within:border-accent/60">
      <input
        ref={noteRef}
        value={loc.notes[d.id] ?? ""}
        onChange={(e) => localActions.setNote(d.id, e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") e.currentTarget.blur();
          const v = e.currentTarget.value.trim();
          if (e.key === "Enter" && !operator && v) void api.decisions.opine(d.id, { option: mine?.option ?? null, note: v }).then(() => localActions.setNote(d.id, ""));
        }}
        placeholder={operator ? "Note, kept with the answer (optional)" : mine ? "Add a note to your opinion, Enter to save" : "Note with your opinion (optional)"}
        aria-label="Note"
        className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-ink/40"
      />
      {!phone && <Kbd keys="n" />}
    </label>
  );

  const header = (
    <>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink/55">
        <KindTag kind={d.kind} batch={isBatch ? d.items.length : undefined} />
        {isBatch ? (
          <span className="code">{d.repo}</span>
        ) : (
          <Link to={`/item/${d.repo}/${d.number}`} className="code text-accent-ink hover:underline">
            {d.repo}#{d.number}
          </Link>
        )}
        <span>asked {ago(d.askedAt)} ago</span>
        <ClaimPill claim={d.claim} />
        {!phone && d.commentCount > 0 && (
          <span className="inline-flex items-center gap-1">
            <MessageSquareIcon className="text-[12px]" /> {d.commentCount}
          </span>
        )}
      </div>
      <h1 className={cn("mt-2 text-pretty font-semibold text-ink", phone ? "text-[17px] leading-6" : "text-lg")}>{d.title}</h1>
    </>
  );

  const summary = (
    <section className="mt-3 rounded-md border border-line bg-ink/[0.025] px-3 py-2.5">
      <div className="mb-1 flex items-center gap-1.5 text-xs text-ink/55">
        <SparklesIcon className="text-[12px] text-accent-ink" />
        <span className="font-semibold text-ink/75">AI summary</span>
        <span>
          · {d.summaryBy} · {ago(d.summaryAt)} ago
        </span>
      </div>
      <p className="text-sm leading-[21px] text-ink/90">{d.summary}</p>
    </section>
  );

  const description = d.body && (
    <Section
      title="Description"
      aside={
        <a className="text-accent-ink hover:underline" href={`https://github.com/storytold/${d.repo}/issues/${d.number}`} target="_blank" rel="noopener noreferrer">
          Open on GitHub
        </a>
      }
    >
      <Collapsible lines={phone ? 15 : 25}>
        <Markdown source={d.body} />
      </Collapsible>
    </Section>
  );

  const facts = (
    <Section title="Key facts">
      <div className="rounded-md border border-line px-3 py-2.5">
        <Facts facts={d.facts} />
      </div>
    </Section>
  );

  const opinions = (
    <Section
      title={
        <>
          Opinions <Count n={d.opinions.length} />
        </>
      }
      aside="Shown to people only, never sent to the pipeline"
    >
      <OpinionList d={d} me={user.login} onAdopt={operator && !d.answer ? (oid) => void adopt(oid) : undefined} />
    </Section>
  );

  const rest = (
    <div className="mt-5">
      {isBatch && (
        <Disclosure title="Items" count={d.items.length} defaultOpen>
          <BatchItems d={d} />
        </Disclosure>
      )}
      {d.context.length > 0 && (
        <Disclosure title="Context">
          <div className="space-y-1 text-sm leading-6 text-ink/80">
            {d.context.map((c, i) => (
              <p key={i}>{c}</p>
            ))}
          </div>
        </Disclosure>
      )}
      {d.publicText && (
        <Disclosure title="Comment posted on GitHub">
          <blockquote className="border-l-2 border-line-strong pl-3 text-sm leading-6 text-ink/75">{d.publicText}</blockquote>
        </Disclosure>
      )}
      <Disclosure title="Classifiers" count={d.classifications.length}>
        <ClassifierLines d={d} />
      </Disclosure>
      {d.related.length > 0 && (
        <Disclosure title="Related" count={d.related.length}>
          <RelatedList d={d} />
        </Disclosure>
      )}
      {phone && (
        <Disclosure title="Discussion" count={d.commentCount}>
          <Thread decisionId={d.id} compact />
        </Disclosure>
      )}
    </div>
  );

  if (phone)
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 pt-3">
          <article className="animate-rise">
            {header}
            {summary}
            {description}
            {facts}
            <div ref={decideRef} className="mt-5 scroll-mt-3">
              {d.answer ? (
                <AnsweredState d={d} canUndo={operator} />
              ) : (
                <>
                  <p className="text-sm font-semibold">{d.question}</p>
                  <p className="mb-2 mt-0.5 text-xs text-ink/55">{modeLine}</p>
                  <OptionButtons options={d.options} recommended={d.recommended} onPick={pick} mode={operator ? "answer" : "opinion"} mine={mine?.option} tally={tally} />
                  <div className="mt-2 flex">{note}</div>
                </>
              )}
            </div>
            {opinions}
            {rest}
          </article>
        </div>
        <div className="flex shrink-0 items-center gap-1 border-t border-line bg-bg px-1 py-1.5">
          <IconButton size="lg" icon={ChevronLeftIcon} label="Previous decision" disabled={!pager?.prev} onClick={pager?.prev} />
          <div className="min-w-0 flex-1 px-1">
            <p className="num text-2xs text-ink/50">{pager?.pos}</p>
            <p className="truncate text-xs font-medium">{d.answer ? "Answered" : d.question}</p>
          </div>
          {!d.answer && (
            <Button size="md" variant="primary" icon={ArrowDownIcon} className="h-10 px-3" onClick={() => decideRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}>
              {operator ? "Answer" : mine ? "Change" : "Give opinion"}
            </Button>
          )}
          <IconButton size="lg" icon={ChevronRightIcon} label="Next decision" disabled={!pager?.next} onClick={pager?.next} />
        </div>
      </div>
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <article className="mx-auto max-w-[760px] px-6 pb-8 pt-5 animate-rise">
          {header}
          {summary}
          {description}
          {facts}
          {rest}
        </article>
      </div>
      <div className="shrink-0 border-t border-line bg-bg px-6 py-3">
        <div className="mx-auto max-w-[760px]">
          {d.answer ? (
            <AnsweredState d={d} canUndo={operator} />
          ) : (
            <>
              <p className="text-sm font-semibold">{d.question}</p>
              <p className="mt-0.5 text-xs text-ink/55">{modeLine}</p>
              <div className="mt-2">
                <OptionButtons options={d.options} recommended={d.recommended} onPick={pick} mode={operator ? "answer" : "opinion"} mine={mine?.option} tally={tally} layout="row" />
              </div>
              <div className="mt-2 flex">{note}</div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function AnsweredState({ d, canUndo }: { d: Decision; canUndo: boolean }) {
  const undo = useUndo();
  const label = d.options.find((o) => o.key === d.answer)?.label ?? d.answer;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-ok/35 bg-ok/[0.06] px-3 py-2.5">
      <CheckIcon className="text-ok" />
      <span className="text-sm font-medium">{label}</span>
      <span className="text-xs text-ink/55">
        by {d.answeredBy}
        {d.adoptedOpinion ? `, adopting ${d.adoptedOpinion.login}'s opinion` : ""} · {ago(d.answeredAt!)} ago · {d.appliedAt ? "applied" : "not applied yet"}
      </span>
      {d.answerNote && <span className="w-full text-sm text-ink/70">“{d.answerNote}”</span>}
      {!d.appliedAt && canUndo && (
        <Button size="sm" variant="ghost" icon={Undo2Icon} className="ml-auto" onClick={() => undo(d.id)}>
          Undo
        </Button>
      )}
    </div>
  );
}

function BatchItems({ d }: { d: Decision }) {
  const loc = useLocal();
  const ov = loc.overrides[d.id] ?? {};
  return (
    <ul className="overflow-hidden rounded-md border border-line">
      {d.items.map((it) => {
        const ref = `${it.repo}#${it.number}`;
        return (
          <li key={ref} className="flex min-h-[34px] items-center gap-3 border-b border-line px-3 last:border-0">
            <Link to={`/item/${it.repo}/${it.number}`} className="code w-[112px] shrink-0 text-accent-ink hover:underline">
              {ref}
            </Link>
            <span className="min-w-0 flex-1 truncate text-sm text-ink/85">{it.title}</span>
            <select
              aria-label={`Answer for ${ref}`}
              value={ov[ref] ?? ""}
              onChange={(e) => localActions.setOverride(d.id, ref, e.target.value || null)}
              className={cn("h-7 shrink-0 rounded border border-line bg-sunken px-1.5 text-xs", ov[ref] ? "text-warn" : "text-ink/55")}
            >
              <option value="">Same as batch</option>
              {d.options.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.label}
                </option>
              ))}
            </select>
          </li>
        );
      })}
    </ul>
  );
}

/** Several checked rows of one kind: one answer (or opinion) for all of them. */
function MultiAnswer({ ds, user }: { ds: Decision[]; user: User }) {
  const answer = useAnswer();
  const api = useApi();
  const access = accessFor(user, ds);
  const kinds = new Set(ds.map((d) => d.kind));
  const optionSig = new Set(ds.map((d) => d.options.map((o) => o.key).join()));
  const same = kinds.size === 1 && optionSig.size === 1;
  const recs = ds.map((d) => d.recommended);
  const rec = recs.every((r) => r === recs[0]) ? recs[0] : "";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-4 pr-10 text-xs text-ink/55">
        <span>{ds.length} selected</span>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={localActions.clearChecked}>
          Clear selection <Kbd keys="Esc" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[720px] px-6 pb-10 pt-5">
          <h1 className="text-lg font-semibold">{same ? `${access.mode === "answer" ? "Answer" : "Give an opinion on"} ${ds.length} ${ds[0].kind} decisions together` : "These decisions ask different questions"}</h1>
          <p className="mt-1 text-sm text-ink/60">{same ? "One pick for all of them. Change single items afterwards from their own page." : "Select decisions of one kind to answer them together."}</p>
          <ul className="mt-4 overflow-hidden rounded-md border border-line">
            {ds.map((d) => (
              <li key={d.id} className="flex h-9 items-center gap-3 border-b border-line px-3 last:border-0">
                <span className="code w-[150px] shrink-0 truncate text-ink/60">{refOf(d)}</span>
                <span className="min-w-0 flex-1 truncate text-sm">{d.title}</span>
                <span className="shrink-0 text-xs text-ink/50">{d.options.find((o) => o.key === d.recommended)?.label}</span>
              </li>
            ))}
          </ul>
          {same && (
            <div className="mt-4">
              <OptionButtons
                options={ds[0].options}
                recommended={rec}
                mode={access.mode}
                onPick={(k) => void (access.mode === "opinion" ? Promise.all(ds.map((d) => api.decisions.opine(d.id, { option: k }))).then(localActions.clearChecked) : answer(ds, k))}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
