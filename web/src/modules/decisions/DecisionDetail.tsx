import { PriorityBadge } from "../../ui/PriorityBadge";
import { QueueBadge } from "../../ui/QueueBadge";
import { useEffect, useRef, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { itemPath } from "../../lib/links";
import { RefLink } from "../../ui/RefLink";
import { FastMarkFor, FastToggle, HoldToggle } from "../queue/fastTrack";
import { CaretLeftIcon, CaretRightIcon, CheckIcon, ArrowUUpLeftIcon, ChatCircleIcon, TrayIcon, SparkleIcon, ArrowDownIcon } from "@phosphor-icons/react";
import { useApi } from "../../api/client";
import type { Decision, User } from "../../api/types";
import type { ViewProps } from "../../registry/types";
import { canAct, canComment } from "../../registry/permissions";
import { Kbd } from "../../ui/Kbd";
import { Button, IconButton } from "../../ui/Button";
import { ConfirmButton, useWrite } from "../admin/parts";
import { Count } from "../../ui/Heading";
import { Markdown, Collapsible } from "../../ui/Markdown";
import { cn } from "../../ui/cn";
import { ago } from "../../lib/format";
import { ClaimPill, ClassifierLines, Disclosure, Facts, KindTag, RelatedList } from "./parts";
import { Refs } from "./Refs";
import { FeedbackBox } from "./FeedbackBox";
import { localActions, ordered, refOf, useDecisionFilter, useDecisionList, useLocal, usePinned, useSelection, useUndo } from "./state";
import { Conversation } from "./Conversation";
import { FeedbackList } from "./Thread";
import { WorkflowBox, scrollToWorkflow } from "./Workflow";
import { useNow } from "../../lib/useNow";

export const canActOn = (user: User, ds: Decision[]): boolean =>
  canAct(user, ds.flatMap((d) => (d.items.length ? d.items.map((i) => i.repo) : [d.repo])));

/** Desktop detail panel: the selected decision, or the batch answer for checked rows. */
export function DetailPanel({ user }: ViewProps) {
  const { data } = useDecisionList();
  const { id, go, item, missing } = useSelection();
  const loc = useLocal();
  const list = ordered(data?.decisions ?? []);
  const checked = list.filter((d) => loc.checked.has(d.id));

  if (checked.length > 1) return <MultiAnswer ds={checked} user={user} />;
  const just = loc.justAnswered.find((x) => x.id === id);
  const inList = list.find((x) => x.id === id);
  const pinned = usePinned(id, !!inList || !!just);
  const d = inList ?? pinned ?? null;
  const idx = d ? list.indexOf(d) : -1;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-4 pr-10 text-xs text-ink/55">
        {data && d && (
          <span className="num">
            {idx + 1} of {list.length}
          </span>
        )}
        <div className="ml-auto flex items-center">
          <IconButton size="sm" icon={CaretLeftIcon} label="Previous (k)" disabled={idx <= 0} onClick={() => go(list[idx - 1])} />
          <IconButton size="sm" icon={CaretRightIcon} label="Next (j)" disabled={idx < 0 || idx >= list.length - 1} onClick={() => go(list[idx + 1])} />
        </div>
      </div>
      {just && !d ? (
        <AnsweredNotice entry={just} />
      ) : d ? (
        <DecisionBody key={d.id} d={d} user={user} onAnswered={() => go(list[idx + 1] ?? list[idx - 1], true)} />
      ) : missing && item ? (
        <NoDecision repo={item.repo} number={item.number} />
      ) : (
        <EmptyDetail count={list.length} />
      )}
    </div>
  );
}

export function NoDecision({ repo, number }: { repo: string; number: number }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
      <p className="text-md font-semibold">
        No decision for {repo}#{number}
      </p>
      <Link to={itemPath(repo, number)} className="text-sm text-accent-ink hover:underline">
        Open the item
      </Link>
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

function AnsweredNotice({ entry }: { entry: { id: string; label: string; ref: string } }) {
  const undo = useUndo();
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="flex items-center gap-3 rounded-md border border-line px-4 py-2.5 text-sm">
        <CheckIcon className="text-ok" />
        <span className="code">{entry.ref}</span>
        <span className="text-ink/70">→ {entry.label}</span>
        <Button size="sm" variant="ghost" icon={ArrowUUpLeftIcon} onClick={() => undo(entry.id)}>
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
  useNow();
  const api = useApi();
  const isBatch = d.number === null;
  const operator = canActOn(user, [d]);
  const commenter = canComment(user);
  const feedbackRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!d.answer && commenter) void api.decisions.claim(d.id);
  }, [api, d.id, d.answer, commenter]);

  const use = (option: string) => {
    localActions.setPick(d.id, option);
    scrollToWorkflow();
  };

  const header = (
    <>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink/55">
        <KindTag kind={d.kind} batch={isBatch ? d.items.length : undefined} />
        {isBatch ? (
          <span className="code">{d.repo}</span>
        ) : (
          <>
            <FastMarkFor repo={d.repo} number={d.number!} />
            <RefLink repo={d.repo} number={d.number!} />
          </>
        )}
        <PriorityBadge p={d.priority} />
        {!isBatch && <QueueBadge slot={d.queue} repo={d.repo} number={d.number!} />}
        <span>asked {ago(d.askedAt)} ago</span>
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
      <h1 className={cn("mt-2 text-pretty font-semibold text-ink", phone ? "text-[17px] leading-6" : "text-lg")}>{d.title}</h1>
    </>
  );

  const summary = d.summary && (
    <section className="mt-3 rounded-md border border-line bg-ink/[0.025] px-3 py-2.5">
      <div className="mb-1 flex items-center gap-1.5 text-xs text-ink/55">
        <SparkleIcon className="text-[12px] text-accent-ink" />
        <span className="font-semibold text-ink/75">AI summary</span>
        <span>
          · {d.summaryBy} · {ago(d.summaryAt)} ago
        </span>
      </div>
      <p className="text-sm leading-[21px] text-ink/90">
        <Refs text={d.summary} repo={d.repo} />
      </p>
    </section>
  );

  const description = d.body && (
    <Section
      title="Description"
      aside={
        isBatch ? undefined : (
          <Link to={itemPath(d.repo, d.number!)} className="text-accent-ink hover:underline">
            Item page
          </Link>
        )
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
        <Facts facts={d.facts} repo={d.repo} />
      </div>
    </Section>
  );

  const feedback = (
    <Section
      title={
        <>
          Feedback <Count n={d.opinions.length + d.commentCount} />
        </>
      }
    >
      <FeedbackList d={d} me={user.login} compact onUse={operator && !d.answer ? use : undefined} onRetract={commenter && !d.answer ? () => void api.decisions.retract(d.id) : undefined} />
      {commenter && <FeedbackBox d={d} className="mt-3" />}
    </Section>
  );

  const question = (
    <div className="mt-5">
      <p className="text-sm font-semibold">
        <Refs text={d.question} repo={d.repo} />
      </p>
      {d.answer && !operator && (
        <div className="mt-2">
          <AnsweredState d={d} canUndo={false} />
        </div>
      )}
    </div>
  );
  const workflow = <WorkflowBox ds={[d]} user={user} phone={phone} onAnswered={onAnswered} />;

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
      {phone && d.number !== null && (
        <Disclosure title="Opus" defaultOpen>
          <Conversation repo={d.repo} number={d.number} operator={operator} />
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
            {question}
            <div ref={feedbackRef} className="scroll-mt-3">{feedback}</div>
            {rest}
            {workflow}
          </article>
        </div>
        <div className="flex shrink-0 items-center gap-1 border-t border-line bg-bg px-1 py-1.5">
          <IconButton size="lg" icon={CaretLeftIcon} label="Previous decision" disabled={!pager?.prev} onClick={pager?.prev} />
          <div className="min-w-0 flex-1 px-1">
            <p className="num text-2xs text-ink/50">{pager?.pos}</p>
            <p className="truncate text-xs font-medium">{d.answer ? "Answered" : d.question}</p>
          </div>
          {commenter && (
            <Button size="md" variant={operator && !d.answer ? "secondary" : "primary"} icon={ChatCircleIcon} className="h-10 px-3" onClick={() => feedbackRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}>
              Feedback
            </Button>
          )}
          {operator && (
            <Button size="md" variant="primary" icon={ArrowDownIcon} className="h-10 px-3" onClick={scrollToWorkflow}>
              Workflow
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
          {summary}
          {description}
          {facts}
          {question}
          {rest}
          {workflow}
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
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-ok/35 bg-ok/[0.06] px-3 py-2.5">
      <CheckIcon className="text-ok" />
      <span className="text-sm font-medium">{label}</span>
      <span className="text-xs text-ink/55">
        by {d.answeredBy}
        {d.adoptedOpinion ? `, using ${d.adoptedOpinion.login}'s answer` : ""} · {ago(d.answeredAt!)} ago{backlog ? "" : ` · ${d.appliedAt ? "applied" : "not applied yet"}`}
      </span>
      {d.answerNote && <span className="w-full text-sm text-ink/70">“{d.answerNote}”</span>}
      {backlog && canUndo && (
        <span className="ml-auto flex items-center gap-2">
          {write.error && <span className="text-xs text-bad">{write.error}</span>}
          <ConfirmButton label="Reopen" confirmLabel="Reopen the decision" loading={write.busy === "reopen"} onConfirm={() => void write.run("reopen", () => api.decisions.reopen(d.id))} />
        </span>
      )}
      {!backlog && !d.appliedAt && canUndo && (
        <Button size="sm" variant="ghost" icon={ArrowUUpLeftIcon} className="ml-auto" onClick={() => undo(d.id)}>
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
            <RefLink repo={it.repo} number={it.number} className="w-[112px] shrink-0" />
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
              <li key={d.id} className="flex h-9 items-center gap-3 border-b border-line px-3 last:border-0">
                <span className="code w-[150px] shrink-0 truncate text-ink/60">{refOf(d)}</span>
                <span className="min-w-0 flex-1 truncate text-sm">{d.title}</span>
                <span className="shrink-0 text-xs text-ink/50">{d.options.find((o) => o.key === d.recommended)?.label}</span>
              </li>
            ))}
          </ul>
          {same && operator && <WorkflowBox ds={ds} user={user} />}
        </div>
      </div>
    </div>
  );
}
