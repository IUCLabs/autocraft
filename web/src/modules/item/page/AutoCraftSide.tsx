import { useEffect, useState, type ReactNode } from "react";
import { localActions, useLocal } from "../../decisions/state";
import { CaretRightIcon, GithubLogoIcon, RobotIcon, WrenchIcon } from "@phosphor-icons/react";
import { useQuery } from "../../../api/client";
import type { HistoryEntry, ItemPageData, OpusReviewEntry, ResultCard, ReviewVerdict } from "../../../api/types";
import { Badge, type Tone } from "../../../ui/atoms/Badge";
import { Chip } from "../../../ui/atoms/Chip";
import { TimeAgo } from "../../../ui/atoms/TimeAgo";
import { cn } from "../../../ui/cn";
import { formatCost } from "../../../lib/trace";
import { githubBlobUrl } from "../../../lib/links";
import { useUser } from "../../../shell/UserContext";
import { canComment } from "../../../registry/permissions";
import { ClockCounterClockwiseIcon } from "@phosphor-icons/react";
import { OpenQuestions, useItemDecisions } from "../ItemDecisions";
import { Composer } from "../Composer";
import { Conversation } from "../Conversation";
import { ItemRef } from "../../../ui/molecules/ItemRef";
import { useJump } from "./ItemPage";
import { PreapprovalCard } from "./PreapprovalCard";
import { SimilarCard } from "./SimilarCard";

const VERDICT: Record<ReviewVerdict, [string, Tone]> = { take: ["Take", "ok"], "take-fix": ["Take with fixes", "warn"], hold: ["Hold", "warn"], close: ["Close", "bad"] };
const TRIGGER: Record<string, string> = { "new-head": "new head", discussion: "discussion", operator: "asked by an operator", "model-change": "model change" };
const sectionCls = "border-b border-line px-4 py-4 md:px-6";

export function Heading({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-2 flex items-baseline gap-2">
      <h2 className="text-sm font-semibold">{children}</h2>
      {aside && <span className="ml-auto text-xs text-ink/55">{aside}</span>}
    </div>
  );
}

export function AutoCraftSide({ d, flash }: { d: ItemPageData; flash: string | null }) {
  const user = useUser();
  const { data: ds } = useItemDecisions(d.repo, d.number);
  const { data: conv } = useQuery(`conversation:${d.repo}#${d.number}`, (a) => a.conversations.get(d.repo, d.number), { pollMs: (x) => (x?.pending ? 4000 : false) });
  const choices = conv ? (conv.choices ?? null) : undefined;
  const open = (ds ?? []).filter((x) => !x.answer);
  const item = `${d.repo}#${d.number}`;
  const updating = useLocal().updating[item];
  const opusTurns = conv?.turns.filter((t) => t.kind === "opus").length ?? 0;
  // The folded choices come back once Opus's reply (new choices, a reply without any, or a failure) is in.
  useEffect(() => {
    if (!updating || !conv || conv.pending) return;
    const failed = [...conv.turns].reverse().find((t) => t.kind === "operator")?.status === "failed";
    if (opusTurns > updating.opusTurns || conv.choices?.id !== updating.choicesId || failed) localActions.stopUpdating(item);
  }, [updating, conv, opusTurns, item]);
  const staff = user.role !== "viewer";
  return (
    <div className="pb-2">
      <div className="px-4 pt-3 text-xs font-semibold text-ink/50 md:px-6">
        <span className="inline-flex items-center gap-1.5 text-accent-ink"><RobotIcon /> In AutoCraft</span>
        {formatCost(d.costUsd) && staff && <span className="num float-right font-normal text-ink/55">{formatCost(d.costUsd)} in all</span>}
      </div>
      {d.header.preapproval && <PreapprovalCard repo={d.repo} number={d.number} p={d.header.preapproval} operator={user.role === "operator"} />}
      {open.length > 0 && (
        <div className={cn(sectionCls, "pt-0")}>
          <OpenQuestions ds={ds ?? []} choices={choices} updating={updating?.decisionId} />
          {open[0]!.opinions.length > 0 && (
            <p className="mt-2 text-xs text-ink/60">
              {open[0]!.opinions.length} feedback: {open[0]!.opinions.slice(0, 2).map((o) => `${o.login}${o.option ? ` ${open[0]!.options.find((x) => x.key === o.option)?.label ?? o.option}` : ""}`).join(", ")}
            </p>
          )}
        </div>
      )}
      {d.reviews.latest && (
        <section className={sectionCls} id="opus-review">
          <ReviewBlock repo={d.repo} reviews={d.reviews} flash={flash} viewer={!staff} />
        </section>
      )}
      {d.results.length > 0 && (
        <section className={cn(sectionCls, "py-2")} aria-label="Results">
          {d.results.map((r) => <ResultRow key={r.id} r={r} />)}
        </section>
      )}
      {staff && conv && (conv.turns.length > 0 || conv.pending || (ds ?? []).some((d) => d.opinions.length > 0)) && (
        <section className={sectionCls} aria-label="Conversation with Opus">
          <Heading aside={user.role === "operator" ? undefined : "Read only"}>Conversation with Opus</Heading>
          <Conversation repo={d.repo} number={d.number} conv={conv} ds={ds ?? []} updating={!!updating} />
        </section>
      )}
      <SimilarCard repo={d.repo} number={d.number} />
      <History d={d} flash={flash} />
      {conv && (
        <Composer flush repo={d.repo} number={d.number} operator={user.role === "operator"} commenter={canComment(user)} exists={conv.exists} pending={conv.pending} feedbackOn={open.length === 1 ? open[0] : undefined} choices={choices} opusTurns={opusTurns} />
      )}
    </div>
  );
}

function ReviewBlock({ repo, reviews, flash, viewer }: { repo: string; reviews: ItemPageData["reviews"]; flash: string | null; viewer: boolean }) {
  const r = reviews.latest!;
  const [more, setMore] = useState(false);
  return (
    <>
      <Heading aside={<TimeAgo iso={r.at} />}>Opus review</Heading>
      <ReviewBody repo={repo} r={r} viewer={viewer} head />
      {reviews.earlier.length > 0 && (
        <div className="mt-3">
          <button onClick={() => setMore(!more)} aria-expanded={more} className="inline-flex h-8 items-center gap-1 text-xs font-medium text-ink/65 hover:text-ink max-md:h-11">
            <CaretRightIcon className={cn("transition-transform duration-fast", more && "rotate-90")} />
            {reviews.earlier.length} earlier {reviews.earlier.length === 1 ? "review" : "reviews"}
          </button>
          {more && (
            <ol className="mt-1 space-y-3 border-l border-line pl-4 animate-fadeIn">
              {reviews.earlier.map((e) => (
                <li key={e.id} id={`rev-${e.id}`} className={cn(flash === `rev-${e.id}` && "bg-accent/10")}>
                  <ReviewBody repo={repo} r={e} viewer={viewer} />
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </>
  );
}

function ReviewBody({ repo, r, viewer, head }: { repo: string; r: OpusReviewEntry; viewer: boolean; head?: boolean }) {
  const [label, tone] = VERDICT[r.verdict];
  return (
    <div className="text-sm">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Badge tone={tone}>{label}</Badge>
        <Badge>{r.sure ? "Sure" : "Unsure"}</Badge>
        <span className="text-xs text-ink/55">
          Review of <span className="code">{r.head}</span> ({r.current ? "current head" : "head has moved"})
          {!head && <> · <TimeAgo iso={r.at} /></>}
        </span>
      </div>
      {r.why && <p className="mt-1.5 text-xs text-ink/55">Ran because: {r.why} ({TRIGGER[r.trigger]})</p>}
      {r.summary && <p className="mt-2 leading-6 text-ink/90">{r.summary}</p>}
      {r.blockedBy.length > 0 && (
        <div className="mt-2.5">
          <div className="text-xs font-medium text-ink/65">Must land first</div>
          <ul className="mt-1 space-y-1">{r.blockedBy.map((b) => <li key={`${b.repo}#${b.number}`}><ItemRef repo={b.repo} number={b.number} title={null} size="sm" /></li>)}</ul>
        </div>
      )}
      {!viewer && r.fixes.length > 0 && <List title="Fixes" items={r.fixes} />}
      {!viewer && r.risks.length > 0 && <List title="Risks" items={r.risks} />}
      {!viewer && head && r.claims.length > 0 && (
        <ul className="mt-2.5 space-y-1.5">
          {r.claims.map((c) => (
            <li key={`${c.path}:${c.line}`} className="text-xs leading-5">
              <a href={githubBlobUrl(repo, r.head, c.path, c.line)} target="_blank" rel="noopener noreferrer" className="code break-all text-accent-ink hover:underline">{c.path}:{c.line}</a>
              <span className="text-ink/65"> {c.text}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const List = ({ title, items }: { title: string; items: string[] }) => (
  <div className="mt-2.5">
    <div className="text-xs font-medium text-ink/65">{title}</div>
    <ul className="mt-0.5 list-disc space-y-0.5 pl-5 text-ink/85">{items.map((i) => <li key={i}>{i}</li>)}</ul>
  </div>
);

const DOT: Record<ResultCard["tone"], string> = { ok: "bg-ok", warn: "bg-warn", bad: "bg-bad", accent: "bg-accent", neutral: "bg-ink/30" };

function ResultRow({ r }: { r: ResultCard }) {
  const [more, setMore] = useState(false);
  return (
    <div className="border-t border-line py-2 first:border-t-0">
      <div className="flex items-start gap-2.5 text-sm">
        <span className={cn("mt-[7px] size-2 shrink-0 rounded-full", DOT[r.tone])} />
        <span className="w-24 shrink-0 font-medium max-md:w-[84px]">{r.title}</span>
        <span className="min-w-0 flex-1 text-ink/80">{r.outcome}{r.detail && <span className="block text-xs text-ink/55">{r.detail}</span>}</span>
        <TimeAgo iso={r.at} className="num shrink-0 text-xs text-ink/45" />
      </div>
      {r.followups && r.followups.length > 0 && (
        <div className="pb-1 pl-[18px] pt-1">
          <div className="text-xs text-ink/55">Follow-ups</div>
          <ul className="mt-1 space-y-1">
            {r.followups.map((f) => <li key={`${f.repo}#${f.number}`}><ItemRef repo={f.repo} number={f.number} title={null} size="sm" /></li>)}
          </ul>
        </div>
      )}
      {r.earlier.length > 0 && (
        <div className="pl-[18px]">
          <button onClick={() => setMore(!more)} aria-expanded={more} className="inline-flex h-7 items-center gap-1 text-xs text-ink/55 hover:text-ink max-md:h-9">
            <CaretRightIcon className={cn("text-[10px] transition-transform duration-fast", more && "rotate-90")} /> {r.earlier.length} earlier
          </button>
          {more && r.earlier.map((e) => <div key={e.at} className="flex gap-2 pl-4 text-xs text-ink/60"><TimeAgo iso={e.at} className="num w-14" /> {e.outcome}</div>)}
        </div>
      )}
    </div>
  );
}

const HISTORY_PAGE = 80;
type Filter = "all" | "model" | "write" | "decision";

function History({ d, flash }: { d: ItemPageData; flash: string | null }) {
  const [f, setF] = useState<Filter>("all");
  const user = useUser();
  const [limit, setLimit] = useState(HISTORY_PAGE);
  const all = d.history.filter((h) => f === "all" || h.kind === f);
  // Oldest first: the newest rows show, and "Show earlier" reveals the rest in steps.
  const rows = all.slice(Math.max(0, all.length - limit));
  return (
    <section className="px-4 py-4 md:px-6" aria-label="History">
      <Heading aside={user.role !== "viewer" && formatCost(d.costUsd) ? <span className="num">{formatCost(d.costUsd)}</span> : undefined}>
        <span className="inline-flex items-center gap-1.5"><ClockCounterClockwiseIcon className="text-ink/50" /> History</span>
      </Heading>
      <div className="mb-2 flex flex-wrap gap-1.5">
        {([["all", "All"], ["model", "Model calls"], ["write", "Writes"], ["decision", "Decisions"]] as [Filter, string][]).map(([k, l]) => (
          <Chip key={k} active={f === k} onClick={() => setF(k)}>{l}</Chip>
        ))}
      </div>
      {all.length > rows.length && (
        <button onClick={() => setLimit(limit + HISTORY_PAGE)} className="mb-1 inline-flex h-8 items-center text-xs font-medium text-accent-ink hover:underline max-md:h-11">Show {Math.min(HISTORY_PAGE, all.length - rows.length)} earlier ({all.length - rows.length} more)</button>
      )}
      <ol>{rows.map((h) => <HistoryRow key={h.id} h={h} itemId={`${d.repo}${d.number}`} flash={flash === `hist-${h.id}`} viewer={user.role === "viewer"} />)}</ol>
    </section>
  );
}

function HistoryRow({ h, flash, viewer }: { h: HistoryEntry; itemId: string; flash: boolean; viewer: boolean }) {
  const [open, setOpen] = useState(false);
  const jump = useJump();
  const cost = viewer ? null : formatCost(h.costUsd);
  return (
    <li id={`hist-${h.id}`} className={cn("border-t border-line transition-colors duration-slow", flash && "bg-accent/10")}>
      <div className="flex items-start gap-2.5 py-2 text-sm">
        <TimeAgo iso={h.at} className="num w-14 shrink-0 pt-px text-xs text-ink/50" />
        <span className={cn("mt-[3px] shrink-0", h.kind === "write" ? "text-accent-ink" : "text-ink/45")}>{h.kind === "write" ? <GithubLogoIcon /> : h.kind === "model" ? <RobotIcon /> : <WrenchIcon />}</span>
        <div className="min-w-0 flex-1">
          <div><span className="font-medium">{h.step}</span> <span className="text-ink/70">{h.outcome}</span></div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-xs text-ink/50">
            {h.model && <span>{h.model}</span>}
            {!viewer && h.calls.length > 0 && (
              <button onClick={() => setOpen(!open)} aria-expanded={open} className="inline-flex h-6 items-center gap-0.5 hover:text-ink max-md:h-9"><CaretRightIcon className={cn("text-[10px] transition-transform duration-fast", open && "rotate-90")} />{h.calls.length} calls</button>
            )}
            {h.writeId && <button onClick={() => jump.to("github", `gh-${h.id}`)} className="inline-flex h-6 items-center text-accent-ink hover:underline max-md:h-9">On GitHub ›</button>}
          </div>
          {open && (
            <ul className="mt-1 space-y-0.5 border-l border-line pl-3 text-xs text-ink/65 animate-fadeIn">
              {h.calls.map((c, i) => <li key={i} className="flex gap-2"><span className="min-w-0 flex-1">{c.label}</span>{formatCost(c.costUsd) && <span className="num">{formatCost(c.costUsd)}</span>}</li>)}
            </ul>
          )}
        </div>
        {cost && <span className="num shrink-0 pt-px text-xs text-ink/55">{cost}</span>}
      </div>
    </li>
  );
}
