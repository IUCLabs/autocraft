import { PriorityBadge } from "../../ui/atoms/PriorityBadge";
import { QueueBadge } from "../../ui/molecules/QueueBadge";
import { useEffect, type ReactNode } from "react";
import { ItemRef } from "../../ui/molecules/ItemRef";
import { FastMarkFor, FastToggle, HoldToggle } from "../queue/fastTrack";
import { CaretLeftIcon, CaretRightIcon, CheckIcon, ArrowUUpLeftIcon, ChatCircleIcon, TrayIcon, SparkleIcon, ArrowDownIcon } from "@phosphor-icons/react";
import { useApi, useQuery } from "../../api/client";
import type { Decision, ItemKind, ItemState, User } from "../../api/types";
import type { ViewProps } from "../../registry/types";
import { canAct, canComment } from "../../registry/permissions";
import { Kbd } from "../../ui/atoms/Kbd";
import { Button, IconButton } from "../../ui/atoms/Button";
import { ConfirmButton, useWrite } from "../admin/parts";
import { cn } from "../../ui/cn";
import {  } from "../../lib/format";
import { TimeAgo } from "../../ui/atoms/TimeAgo";
import { ClaimPill, ClassifierLines, Disclosure, Facts, KindTag, RelatedList } from "./parts";
import { Refs } from "./Refs";
import { ExecLine } from "./ExecLine";
import { DuplicateGroup, RiskList } from "./Group";
import { localActions, ordered, refOf, useDecisionFilter, useDecisionList, useLocal, usePinned, useSelection, useUndo } from "./state";
import { WorkflowBox } from "./Workflow";
import { ItemThread } from "../item/ItemThread";
import { scrollToThreadEnd } from "../item/ItemDecisions";
import { useNow } from "../../lib/useNow";

export const canActOn = (user: User, ds: Decision[]): boolean =>
  ds.every((d) => d.canSettle) && canAct(user, ds.flatMap((d) => (d.items.length ? d.items.map((i) => i.repo) : [d.repo])));

/** Undo and retry: an operator takes back any answer, a maintainer only their own. */
export const canTakeBack = (user: User, d: Decision): boolean => canActOn(user, [d]) && (user.role === "operator" || d.answeredBy?.toLowerCase() === user.login.toLowerCase());

/** Desktop detail panel: the selected decision, or the batch answer for checked rows. */
export function DetailPanel({ user }: ViewProps) {
  const { data } = useDecisionList();
  const { id, go, item, missing } = useSelection();
  const loc = useLocal();
  const list = ordered(data?.decisions ?? []);
  const checked = list.filter((d) => loc.checked.has(d.id));

  if (checked.length > 1) return <MultiAnswer ds={checked} user={user} />;
  const inList = list.find((x) => x.id === id);
  const pinned = usePinned(id, !!inList);
  const d = inList ?? pinned ?? null;
  const idx = d ? list.indexOf(d) : -1;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-4 pr-10 text-xs text-ink/55">
        {data && idx >= 0 && (
          <span className="num">
            {idx + 1} of {list.length}
          </span>
        )}
        <div className="ml-auto flex items-center">
          <IconButton size="sm" icon={CaretLeftIcon} label="Previous (k)" disabled={idx <= 0} onClick={() => go(list[idx - 1])} />
          <IconButton size="sm" icon={CaretRightIcon} label="Next (j)" disabled={idx >= list.length - 1} onClick={() => go(list[idx + 1])} />
        </div>
      </div>
      {d ? (
        <DecisionBody key={d.id} d={d} user={user} />
      ) : missing && item ? (
        <NoDecision repo={item.repo} number={item.number} />
      ) : (
        <EmptyDetail count={list.length} />
      )}
    </div>
  );
}

export function NoDecision({ repo, number, kind, state, title }: { repo: string; number: number; kind?: ItemKind; state?: ItemState; title?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
      <p className="text-md font-semibold">No decision for this item</p>
      <ItemRef repo={repo} number={number} kind={kind} state={state} title={title ?? null} className="max-w-md text-left" />
    </div>
  );
}

function EmptyDetail({ count }: { count: number }) {
  const { filter } = useDecisionFilter();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
      <TrayIcon className="text-[28px] text-ink/25" />
      {count === 0 ? (
        <>
          {filter.status === "backlog" ? (
            <p className="text-md font-semibold">Nothing in the backlog</p>
          ) : (
            <>
              <p className="text-md font-semibold">Nothing waiting</p>
              <p className="text-sm text-ink/55">Every decision in this view has an answer.</p>
            </>
          )}
        </>
      ) : (
        <p className="text-sm text-ink/55">
          Select a decision. <Kbd keys="j" /> and <Kbd keys="k" /> move through the list.
        </p>
      )}
    </div>
  );
}

function Section({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <section className="mt-5">
      <h2 className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-ink/60">{title}</h2>
      {children}
    </section>
  );
}

/** The thread of the decision's item (a batch: its first item) with this decision at the end. */
function DecisionThread({ d, onAnswered }: { d: Decision; onAnswered?: () => void }) {
  const ref = d.number === null ? d.items[0] : { repo: d.repo, number: d.number };
  const { data: it } = useQuery(ref ? `item:${ref.repo}#${ref.number}` : "item:none", (api) => api.item(ref!.repo, ref!.number), { enabled: !!ref });
  if (!ref) return null;
  return <ItemThread repo={ref.repo} number={ref.number} it={it} decision={d} onAnswered={onAnswered} />;
}

/**
 * The decision: header, AI summary, facts and risks, details, then the item's thread with the question at its end. Shared by the desktop detail panel and the phone pager;
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
  useNow();
  const api = useApi();
  const isBatch = d.number === null;
  const operator = canActOn(user, [d]);
  const commenter = canComment(user);

  useEffect(() => {
    if (!d.answer && commenter) void api.decisions.claim(d.id);
  }, [api, d.id, d.answer, commenter]);

  const header = (
    <>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink/55">
        <KindTag kind={d.kind} batch={isBatch ? d.items.length : undefined} />
        {isBatch ? (
          <span className="code">{d.repo}</span>
        ) : (
          <>
            <FastMarkFor repo={d.repo} number={d.number!} />
          </>
        )}
        <PriorityBadge p={d.priority} />
        {!isBatch && <QueueBadge slot={d.queue} />}
        <span>asked <TimeAgo iso={d.askedAt} /></span>
        <ClaimPill claim={d.claim} />
        {!isBatch && (
          <span className="ml-auto flex flex-wrap items-center gap-1.5">
            <FastToggle repo={d.repo} number={d.number!} className="h-6 max-md:h-11" />
            {(d.kind === "merge" || d.kind === "close") && <HoldToggle repo={d.repo} number={d.number!} className="h-6 max-md:h-11" />}
          </span>
        )}
        {!phone && d.commentCount > 0 && (
          <span className="inline-flex items-center gap-1">
            <ChatCircleIcon className="text-[12px]" /> {d.commentCount}
          </span>
        )}
      </div>
      {!isBatch && d.group.length === 0 && <ItemRef repo={d.repo} number={d.number!} kind={d.shown?.kind} state={d.shown?.state} title={null} size="sm" className="mt-2 text-ink/55" />}
      <h1 className={cn("mt-2 text-pretty font-semibold text-ink", phone ? "text-[17px] leading-6" : "text-lg")}>{d.title}</h1>
    </>
  );

  const group = d.group.length > 0 && <DuplicateGroup d={d} />;
  const risks = d.risks.length > 0 && <RiskList risks={d.risks} />;

  const summary = d.summary && (
    <section className="mt-3 rounded-md border border-line bg-ink/[0.025] px-3 py-2.5">
      <div className="mb-1 flex items-center gap-1.5 text-xs text-ink/55">
        <SparkleIcon className="text-[12px] text-accent-ink" />
        <span className="font-semibold text-ink/75">AI summary</span>
        <span>
          · {d.summaryBy} · <TimeAgo iso={d.summaryAt} />
        </span>
      </div>
      <p className="text-sm leading-[21px] text-ink/90">
        <Refs text={d.summary} repo={d.repo} />
      </p>
    </section>
  );

  const facts = (
    <Section title="Key facts">
      <div className="rounded-md border border-line px-3 py-2.5">
        <Facts facts={d.facts} repo={d.repo} />
      </div>
    </Section>
  );

  const question = (
    <p className="mt-3 text-sm font-semibold">
      <Refs text={d.question} repo={d.repo} />
    </p>
  );

  const items = isBatch && (
    <div className="mt-5">
      <Disclosure title="Items" count={d.items.length} defaultOpen>
        <BatchItems d={d} />
      </Disclosure>
    </div>
  );

  const rest = (
    <div className="mt-5">
      <Disclosure title="Details">
      {d.context.length > 0 && (
        <Disclosure title="Context">
          <div className="space-y-1 text-sm leading-6 text-ink/80">
            {d.context.map((c, i) => (
              <p key={i}>
                <Refs text={c} repo={d.repo} />
              </p>
            ))}
          </div>
        </Disclosure>
      )}
      {d.publicText && (
        <Disclosure title={d.kind === "merge" ? "Comment posted on GitHub if closed" : "Comment posted on GitHub"}>
          <blockquote className="whitespace-pre-wrap border-l-2 border-line-strong pl-3 text-sm leading-6 text-ink/75">{d.publicText}</blockquote>
        </Disclosure>
      )}
      {d.optionTexts?.length > 0 && (
        <Disclosure title="Comments posted on GitHub" defaultOpen>
          <div className="space-y-3">
            {d.optionTexts.map((ot) => (
              <div key={ot.option}>
                <div className="text-xs font-medium text-ink/60">{d.options.find((o) => o.key === ot.option)?.label ?? ot.option}</div>
                {ot.texts.length === 0 && <p className="text-sm text-ink/60">No comments.</p>}
                {ot.texts.map((t) => (
                  <div key={`${t.number}:${t.step}`} className="mt-1">
                    <div className="text-xs text-ink/50">
                      {t.step === "suggestion" ? "If the branch cannot be pushed to, on" : "On"} #{t.number}
                    </div>
                    <blockquote className="whitespace-pre-wrap border-l-2 border-line-strong pl-3 text-sm leading-6 text-ink/75">{t.text}</blockquote>
                  </div>
                ))}
              </div>
            ))}
          </div>
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
      </Disclosure>
    </div>
  );

  if (phone)
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 pt-3">
          <article className="animate-rise">
            {header}
            {question}
            {group}
            {summary}
            {risks}
            {facts}
            {items}
            {rest}
            <DecisionThread d={d} onAnswered={onAnswered} />
          </article>
        </div>
        <div className="flex shrink-0 items-center gap-1 border-t border-line bg-bg px-1 py-1.5">
          <IconButton size="lg" icon={CaretLeftIcon} label="Previous decision" disabled={!pager?.prev} onClick={pager?.prev} />
          <div className="min-w-0 flex-1 px-1">
            <p className="num text-2xs text-ink/50">{pager?.pos}</p>
            <p className="truncate text-xs font-medium">{d.answer ? "Answered" : d.question}</p>
          </div>
          {commenter && (
            <Button size="md" variant="primary" icon={operator && !d.answer ? ArrowDownIcon : ChatCircleIcon} className="h-10 px-3" onClick={scrollToThreadEnd}>
              {operator && !d.answer ? "Answer" : "Reply"}
            </Button>
          )}
          <IconButton size="lg" icon={CaretRightIcon} label="Next decision" disabled={!pager?.next} onClick={pager?.next} />
        </div>
      </div>
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <article className="mx-auto max-w-[760px] px-6 pb-8 pt-5 animate-rise">
          {header}
          {question}
          {group}
          {summary}
          {risks}
          {facts}
          {items}
          {rest}
          <DecisionThread d={d} onAnswered={onAnswered} />
        </article>
      </div>
    </div>
  );
}

export function AnsweredState({ d, canUndo }: { d: Decision; canUndo: boolean }) {
  useNow();
  const undo = useUndo();
  const api = useApi();
  const write = useWrite();
  const label = d.options.find((o) => o.key === d.answer)?.label ?? d.answer;
  const backlog = d.answer === "backlog";
  // Handled and withdrawn answers are closed when given: no step applies them and none can be undone.
  const closed = backlog || d.answer === "handled" || d.answer === "withdrawn";
  const error = useLocal().undoError;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-ok/35 bg-ok/[0.06] px-3 py-2.5">
      <CheckIcon className="text-ok" />
      <span className="text-sm font-medium">{label}</span>
      <span className="text-xs text-ink/55">
        by {d.answeredBy}
        {d.adoptedOpinion ? `, using ${d.adoptedOpinion.login}'s answer` : ""} · <TimeAgo iso={d.answeredAt!} />{closed ? "" : ` · ${d.appliedAt ? "applied" : "not applied yet"}`}
      </span>
      {d.answerNote && <span className="w-full text-sm text-ink/70">“{d.answerNote}”</span>}
      <ExecLine d={d} canRetry={canUndo} />
      {backlog && canUndo && (
        <span className="ml-auto flex items-center gap-2">
          {write.error && <span className="text-xs text-bad">{write.error}</span>}
          <ConfirmButton label="Reopen" confirmLabel="Reopen the decision" loading={write.busy === "reopen"} onConfirm={() => void write.run("reopen", () => api.decisions.reopen(d.id))} />
        </span>
      )}
      {!backlog && d.undoable && canUndo && (
        <span className="ml-auto flex items-center gap-2">
          {error?.id === d.id && <span className="text-xs text-bad">{error.message}</span>}
          <Button size="sm" variant="ghost" icon={ArrowUUpLeftIcon} onClick={() => undo(d.id)}>
            Undo
          </Button>
        </span>
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
          <li key={ref} className="flex min-h-[34px] items-start gap-3 border-b border-line px-3 py-1.5 last:border-0">
            <ItemRef repo={it.repo} number={it.number} kind={it.kind} state={it.state} title={it.title} className="flex-1" />
            <select
              aria-label={`Answer for ${ref}`}
              value={ov[ref] ?? ""}
              onChange={(e) => localActions.setOverride(d.id, ref, e.target.value || null)}
              className={cn("h-7 shrink-0 self-center rounded border border-line bg-sunken px-1.5 text-xs", ov[ref] ? "text-warn" : "text-ink/55")}
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

/** Several checked rows of one kind: one answer for all of them, through the Workflow box. */
function MultiAnswer({ ds, user }: { ds: Decision[]; user: User }) {
  const operator = canActOn(user, ds);
  const kinds = new Set(ds.map((d) => d.kind));
  const optionSig = new Set(ds.map((d) => d.options.map((o) => o.key).join()));
  const same = kinds.size === 1 && optionSig.size === 1;

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
          <h1 className="text-lg font-semibold">{same && operator ? `Answer ${ds.length} ${ds[0].kind} decisions together` : same ? `${ds.length} ${ds[0].kind} decisions selected` : "These decisions ask different questions"}</h1>
          <p className="mt-1 text-sm text-ink/60">{!operator ? "Open one decision to leave a comment." : same ? "One answer for all of them. Change single items afterwards from their own page." : "Select decisions of one kind to answer them together."}</p>
          <ul className="mt-4 overflow-hidden rounded-md border border-line">
            {ds.map((d) => (
              <li key={d.id} className="flex min-h-9 items-start gap-3 border-b border-line px-3 py-1.5 last:border-0">
                <div className="min-w-0 flex-1">
                  {d.number === null ? (
                    <span className="code text-sm text-ink/60">{refOf(d)}</span>
                  ) : (
                    <ItemRef repo={d.repo} number={d.number} kind={d.shown?.kind} state={d.shown?.state} title={null} />
                  )}
                  <div className="text-sm text-ink/70">{d.title}</div>
                </div>
                <span className="shrink-0 pt-0.5 text-xs text-ink/50">{d.options.find((o) => o.key === d.recommended)?.label}</span>
              </li>
            ))}
          </ul>
          {same && operator && <WorkflowBox ds={ds} user={user} />}
        </div>
      </div>
    </div>
  );
}
