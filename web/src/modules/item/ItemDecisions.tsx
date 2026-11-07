import { Link } from "react-router-dom";
import { ArrowRightIcon, ChatCircleIcon } from "@phosphor-icons/react";
import { useQuery } from "../../api/client";
import type { Decision, DecisionChoices } from "../../api/types";
import { useUser } from "../../shell/UserContext";
import { KindTag } from "../decisions/parts";
import { Refs } from "../decisions/Refs";
import { AnswerNotice } from "../decisions/AnswerNotice";
import { ChoiceGroup } from "./ChoiceGroup";
import { canComment } from "../../registry/permissions";
import { FeedbackBox } from "../decisions/FeedbackBox";
import { useFolded, useLocal } from "../decisions/state";
import { AnsweredState, canActOn, canTakeBack } from "../decisions/DecisionDetail";
import { RecommendationLine } from "../../ui/molecules/RecommendationLine";
import { OpusWorking } from "../../ui/molecules/OpusWorking";
import { TimeAgo } from "../../ui/atoms/TimeAgo";
import { decisionPath } from "../../lib/links";

/** Every decision about one item (its own, or a group that lists it), open first. The key is a live topic prefix. */
export function useItemDecisions(repo: string, number: number) {
  const q = useQuery(`item-decisions:${repo}#${number}`, async (api) => {
    const filter = { repo: [repo], number };
    const [open, snoozed, answered] = await Promise.all([api.decisions.list({ ...filter, status: "open" }), api.decisions.list({ ...filter, status: "snoozed" }), api.decisions.list({ ...filter, status: "answered" })]);
    return [...open.decisions, ...snoozed.decisions, ...answered.decisions];
  });
  const data = useFolded(q.data);
  return { ...q, data };
}

export const THREAD_END_ID = "thread-end";

/** Phone bar button: brings the end of the thread (question, options, composer) into view. */
export const scrollToThreadEnd = () => document.getElementById(THREAD_END_ID)?.scrollIntoView({ behavior: "smooth", block: "start" });

/**
 * The item's open questions at the end of the thread: the question and its answer choices (`choices`, those of the first question), answerable in place with the Decisions page's controls and permission rules.
 * On a decision page, `focus` comes first, shows its answer with Undo once answered, and has no link to itself.
 */
export function OpenQuestions({ ds, focus, choices, updating, onAnswered, boxes }: { ds: Decision[]; focus?: Decision; choices?: DecisionChoices | null; updating?: string; onAnswered?: () => void; boxes?: boolean }) {
  const loc = useLocal();
  const user = useUser();
  const open = ds.filter((d) => !d.answer);
  const notices = focus ? [] : loc.justAnswered.filter((a) => ds.some((d) => d.id === a.id));
  if (!open.length && !notices.length && !focus) return null;
  return (
    <section id={THREAD_END_ID} className="mt-6 scroll-mt-3 space-y-3" aria-label="Open question">
      {notices.map((a) => (
        <AnswerNotice key={a.id} entry={a} className="rounded-md border border-line px-3" />
      ))}
      {focus?.answer && <AnsweredState d={focus} canUndo={canTakeBack(user, focus)} />}
      {open.map((d) => (
        <Question key={d.id} d={d} siblings={ds} choices={choices === undefined ? undefined : choices?.decisionId === d.id ? choices : null} updating={updating === d.id} here={d.id === focus?.id} onAnswered={onAnswered} feedback={!!boxes && d.id !== focus?.id} />
      ))}
    </section>
  );
}

function Question({ d, siblings, choices, updating, here, onAnswered, feedback }: { d: Decision; siblings: Decision[]; choices?: DecisionChoices | null; updating: boolean; here: boolean; onAnswered?: () => void; feedback: boolean }) {
  const user = useUser();
  return (
    <article className="rounded-md border border-line-strong px-3 py-3 md:px-4">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink/55">
        <KindTag kind={d.kind} batch={d.number === null ? d.items.length : undefined} />
        <span>asked <TimeAgo iso={d.askedAt} /></span>
        {d.commentCount > 0 && (
          <span className="inline-flex items-center gap-1">
            <ChatCircleIcon className="text-[12px]" /> {d.commentCount}
          </span>
        )}
        {!here && (
          <Link to={decisionPath(d, { siblings })} className="ml-auto inline-flex items-center gap-1 text-accent-ink hover:underline max-md:h-11 max-md:items-center">
            Open decision <ArrowRightIcon className="text-[12px]" />
          </Link>
        )}
      </div>
      <p className="mt-2 text-pretty text-[15px] font-semibold leading-6">
        <Refs text={d.question} repo={d.repo} />
      </p>
      {/* While Opus prepares or answers a message, the earlier choices are about to be replaced, so only the progress line shows. */}
      {(d.preparing || updating) && !d.answer ? (
        <OpusWorking text={d.preparing ? "Opus is preparing options…" : "Opus is updating the choices…"} className="mt-2" />
      ) : choices === undefined && d.number !== null && d.group.length === 0 ? null : (
        <>
          {!choices && <div className="mt-2"><RecommendationLine d={d} /></div>}
          <ChoiceGroup d={d} user={user} choices={choices} onAnswered={onAnswered} />
        </>
      )}
      {/* With several open questions the composer serves one; the others get their own box. */}
      {feedback && canComment(user) && !canActOn(user, [d]) && <FeedbackBox d={d} className="mt-3" />}
    </article>
  );
}
