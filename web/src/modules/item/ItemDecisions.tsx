import { Link } from "react-router-dom";
import { ArrowRightIcon, ChatCircleIcon } from "@phosphor-icons/react";
import { useApi, useQuery } from "../../api/client";
import type { Decision } from "../../api/types";
import { useUser } from "../../shell/UserContext";
import { canComment } from "../../registry/permissions";
import { KindTag } from "../decisions/parts";
import { Refs } from "../decisions/Refs";
import { FeedbackBox } from "../decisions/FeedbackBox";
import { FeedbackList } from "../decisions/Thread";
import { AnswerNotice } from "../decisions/AnswerNotice";
import { canActOn } from "../decisions/DecisionDetail";
import { WorkflowBox } from "../decisions/Workflow";
import { localActions, useLocal } from "../decisions/state";
import { RecommendationLine } from "../../ui/molecules/RecommendationLine";
import { TimeAgo } from "../../ui/atoms/TimeAgo";
import { useIsPhone } from "../../shell/useMedia";
import { decisionPath } from "../../lib/links";

/** Every decision about one item (its own, or a group that lists it), open first. The key is a live topic prefix. */
export function useItemDecisions(repo: string, number: number) {
  return useQuery(`item-decisions:${repo}#${number}`, async (api) => {
    const filter = { repo: [repo], number };
    const [open, answered] = await Promise.all([api.decisions.list({ ...filter, status: "open" }), api.decisions.list({ ...filter, status: "answered" })]);
    return [...open.decisions, ...answered.decisions];
  });
}

/** The item's open questions, answerable in place with the Decisions page's controls and permission rules. */
export function ItemQuestions({ repo, number }: { repo: string; number: number }) {
  const { data: ds } = useItemDecisions(repo, number);
  const loc = useLocal();
  const open = ds?.filter((d) => !d.answer) ?? [];
  const notices = loc.justAnswered.filter((a) => ds?.some((d) => d.id === a.id));
  if (!open.length && !notices.length) return null;
  return (
    <section className="mt-6" aria-label="Open questions">
      <h2 className="mb-2 text-sm font-semibold">
        {open.length === 1 ? "Open question" : "Open questions"}
      </h2>
      {notices.map((a) => (
        <AnswerNotice key={a.id} entry={a} className="mb-2 rounded-md border border-line px-3" />
      ))}
      <div className="space-y-3">
        {open.map((d) => (
          <Question key={d.id} d={d} siblings={ds ?? []} />
        ))}
      </div>
    </section>
  );
}

function Question({ d, siblings }: { d: Decision; siblings: Decision[] }) {
  const user = useUser();
  const api = useApi();
  const phone = useIsPhone();
  const commenter = canComment(user);
  const operator = canActOn(user, [d]);
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
        <Link to={decisionPath(d, { siblings })} className="ml-auto inline-flex items-center gap-1 text-accent-ink hover:underline max-md:h-11 max-md:items-center">
          Open decision <ArrowRightIcon className="text-[12px]" />
        </Link>
      </div>
      <p className="mt-2 text-pretty text-[15px] font-semibold leading-6">
        <Refs text={d.question} repo={d.repo} />
      </p>
      {!operator && <div className="mt-2"><RecommendationLine d={d} /></div>}
      <WorkflowBox ds={[d]} user={user} phone={phone} />
      {(d.opinions.length > 0 || d.commentCount > 0) && (
        <div className="mt-4">
          <FeedbackList d={d} me={user.login} compact onUse={operator ? (o) => localActions.setPick(d.id, o) : undefined} onRetract={commenter ? () => void api.decisions.retract(d.id) : undefined} />
        </div>
      )}
      {commenter && <FeedbackBox d={d} className="mt-3" />}
    </article>
  );
}
