import { useEffect } from "react";
import { ChatCircleIcon } from "@phosphor-icons/react";
import { useApi, useQuery } from "../../api/client";
import type { Decision, DecisionChoices } from "../../api/types";
import { useUser } from "../../shell/UserContext";
import { KindTag } from "../decisions/parts";
import { Refs } from "../decisions/Refs";
import { AnswerNotice } from "../decisions/AnswerNotice";
import { ChoiceGroup } from "./ChoiceGroup";
import { canComment } from "../../registry/permissions";
import { FeedbackBox } from "../decisions/FeedbackBox";
import { useFolded, useLocal } from "../decisions/state";
import { canActOn } from "../decisions/access";
import { DecisionChips, DecisionDetails, DecisionSummary } from "../decisions/DecisionBlocks";
import { DuplicateGroup, RiskList } from "../decisions/Group";
import { RecommendationLine } from "../../ui/molecules/RecommendationLine";
import { OpusWorking } from "../../ui/molecules/OpusWorking";
import { TimeAgo } from "../../ui/atoms/TimeAgo";

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

/**
 * The item's open decisions at the top of its AutoCraft side: each with its question, summary, answer choices (`choices`, those of the first decision), facts and details,
 * answerable in place with the Decisions controls and permission rules. A just-answered decision shows its answer notice until the record is in History.
 */
export function OpenQuestions({ ds, choices, updating, boxes }: { ds: Decision[]; choices?: DecisionChoices | null; updating?: string; boxes?: boolean }) {
  const loc = useLocal();
  const open = ds.filter((d) => !d.answer);
  const notices = loc.justAnswered.filter((a) => ds.some((d) => d.id === a.id));
  if (!open.length && !notices.length) return null;
  return (
    <section className="mt-3 space-y-3" aria-label="Open decisions">
      {notices.map((a) => (
        <AnswerNotice key={a.id} entry={a} className="rounded-md border border-line px-3" />
      ))}
      {open.map((d) => (
        <Question key={d.id} d={d} choices={choices === undefined ? undefined : choices?.decisionId === d.id ? choices : null} updating={updating === d.id} feedback={!!boxes} />
      ))}
    </section>
  );
}

function Question({ d, choices, updating, feedback }: { d: Decision; choices?: DecisionChoices | null; updating: boolean; feedback: boolean }) {
  const user = useUser();
  const api = useApi();
  const commenter = canComment(user);
  // Opening a decision marks it as being looked at by this person.
  useEffect(() => {
    if (!d.answer && commenter) void api.decisions.claim(d.id);
  }, [api, d.id, d.answer, commenter]);
  return (
    <article id={`decision-${d.id}`} className="scroll-mt-3 rounded-md border border-line-strong px-3 py-3 md:px-4">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink/55">
        <KindTag kind={d.kind} batch={d.number === null ? d.items.length : undefined} />
        <span>asked <TimeAgo iso={d.askedAt} /></span>
        {d.commentCount > 0 && (
          <span className="inline-flex items-center gap-1">
            <ChatCircleIcon className="text-[12px]" /> {d.commentCount}
          </span>
        )}
        <DecisionChips d={d} />
      </div>
      <p className="mt-2 text-pretty text-[15px] font-semibold leading-6">
        <Refs text={d.question} repo={d.repo} />
      </p>
      {d.group.length > 0 && <DuplicateGroup d={d} />}
      <DecisionSummary d={d} />
      {d.risks.length > 0 && <RiskList risks={d.risks} />}
      {/* While Opus prepares or answers a message, the earlier choices are about to be replaced, so only the progress line shows. */}
      {(d.preparing || updating) && !d.answer ? (
        <OpusWorking text={d.preparing ? "Opus is preparing options…" : "Opus is updating the choices…"} className="mt-2" />
      ) : choices === undefined && d.number !== null && d.group.length === 0 ? null : (
        <>
          {d.preparedEarlier && !d.answer && <p className="mt-2 text-xs text-ink/55">Prepared earlier. Re-prepare to update the choices.</p>}
          {!choices && <div className="mt-2"><RecommendationLine d={d} /></div>}
          <ChoiceGroup d={d} user={user} choices={choices} />
        </>
      )}
      <DecisionDetails d={d} />
      {/* With several open questions the composer serves one; the others get their own box. */}
      {feedback && canComment(user) && !canActOn(user, [d]) && <FeedbackBox d={d} className="mt-3" />}
    </article>
  );
}
