import { PriorityBadge } from "../../ui/PriorityBadge";
import { useEffect, useRef, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { RefLink } from "../../ui/RefLink";
import { ChevronLeftIcon, ChevronRightIcon, CheckIcon, Undo2Icon, MessageSquareIcon, InboxIcon, SparklesIcon, ArrowDownIcon } from "lucide-react";
import { useApi } from "../../api/client";
import type { Decision, User } from "../../api/types";
import type { ViewProps } from "../../registry/types";
import { canAct } from "../../registry/permissions";
import { Kbd } from "../../ui/Kbd";
import { Button, IconButton } from "../../ui/Button";
import { Count } from "../../ui/Heading";
import { Markdown, Collapsible } from "../../ui/Markdown";
import { cn } from "../../ui/cn";
import { ago } from "../../lib/format";
import { ClaimPill, ClassifierLines, Disclosure, Facts, KindTag, OpinionList, RelatedList } from "./parts";
import { Refs } from "./Refs";
import { ReviewBox } from "./ReviewBox";
import { localActions, ordered, refOf, useDecisionList, useLocal, useSelection, useUndo } from "./state";
import { Thread } from "./Thread";
import { WorkflowBox, scrollToWorkflow } from "./Workflow";

export const canActOn = (user: User, ds: Decision[]): boolean =>
  canAct(user, ds.flatMap((d) => (d.items.length ? d.items.map((i) => i.repo) : [d.repo])));

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
        <DecisionBody key={d.id} d={d} user={user} onAnswered={() => go(list[idx + 1]?.id ?? list[idx - 1]?.id, true)} />
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
  const isBatch = d.number === null;
  const operator = canActOn(user, [d]);
  const reviewRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!d.answer) void api.decisions.claim(d.id);
  }, [api, d.id, d.answer]);

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
          <RefLink repo={d.repo} number={d.number!} />
        )}
        <PriorityBadge p={d.priority} />
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

  const summary = d.summary && (
    <section className="mt-3 rounded-md border border-line bg-ink/[0.025] px-3 py-2.5">
      <div className="mb-1 flex items-center gap-1.5 text-xs text-ink/55">
        <SparklesIcon className="text-[12px] text-accent-ink" />
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
          <Link to={`/item/${d.repo}/${d.number}`} className="text-accent-ink hover:underline">
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

  const opinions = (
    <Section
      title={
        <>
          Comments <Count n={d.opinions.length} />
        </>
      }
    >
      <OpinionList d={d} me={user.login} onUse={operator && !d.answer ? use : undefined} onRetract={() => void api.decisions.retract(d.id)} />
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
        <Disclosure title={d.kind === "merge" ? "Comment posted on GitHub if closed" : d.id.includes(":dupegroup:") ? "Comments posted on GitHub" : "Comment posted on GitHub"}>
          <blockquote className="whitespace-pre-wrap border-l-2 border-line-strong pl-3 text-sm leading-6 text-ink/75">{d.publicText}</blockquote>
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
            {question}
            {opinions}
            {rest}
            <div ref={reviewRef} className="mt-5 scroll-mt-3 border-t border-line pt-4">
              <ReviewBox d={d} />
            </div>
            {workflow}
          </article>
        </div>
        <div className="flex shrink-0 items-center gap-1 border-t border-line bg-bg px-1 py-1.5">
          <IconButton size="lg" icon={ChevronLeftIcon} label="Previous decision" disabled={!pager?.prev} onClick={pager?.prev} />
          <div className="min-w-0 flex-1 px-1">
            <p className="num text-2xs text-ink/50">{pager?.pos}</p>
            <p className="truncate text-xs font-medium">{d.answer ? "Answered" : d.question}</p>
          </div>
          <Button size="md" variant={operator && !d.answer ? "secondary" : "primary"} icon={MessageSquareIcon} className="h-10 px-3" onClick={() => reviewRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}>
            Comment
          </Button>
          {operator && (
            <Button size="md" variant="primary" icon={ArrowDownIcon} className="h-10 px-3" onClick={scrollToWorkflow}>
              Workflow
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
          {question}
          {rest}
          {workflow}
        </article>
      </div>
    </div>
  );
}

export function AnsweredState({ d, canUndo }: { d: Decision; canUndo: boolean }) {
  const undo = useUndo();
  const label = d.options.find((o) => o.key === d.answer)?.label ?? d.answer;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-ok/35 bg-ok/[0.06] px-3 py-2.5">
      <CheckIcon className="text-ok" />
      <span className="text-sm font-medium">{label}</span>
      <span className="text-xs text-ink/55">
        by {d.answeredBy}
        {d.adoptedOpinion ? `, using ${d.adoptedOpinion.login}'s answer` : ""} · {ago(d.answeredAt!)} ago · {d.appliedAt ? "applied" : "not applied yet"}
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
