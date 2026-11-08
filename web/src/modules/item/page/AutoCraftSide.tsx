// The AutoCraft side of the item page: the open question (if any), then the item's story, then the composer.
import { useEffect } from "react";
import { localActions, useLocal } from "../../decisions/state";
import { useQuery } from "../../../api/client";
import type { ItemPageData } from "../../../api/types";
import { useUser } from "../../../shell/UserContext";
import { canAct, canComment } from "../../../registry/permissions";
import { OpenQuestions, useItemDecisions } from "../ItemDecisions";
import { ActionCard } from "../OpusCards";
import { Composer } from "../Composer";
import { SimilarCard } from "./SimilarCard";
import { Story } from "./Story";

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
  // Only the newest Opus turn's cards are live: a card that leaves the question open is a suggested reply.
  const lastOpus = conv ? [...conv.turns].reverse().find((t) => t.kind === "opus") : undefined;
  const suggestions = lastOpus?.actions.filter((a) => a.settles === undefined && !a.fromChoice && ["proposed", "running", "failed"].includes(a.state) && a.canSettle) ?? [];
  return (
    <div className="pb-2">
      {open.length > 0 && (
        <div className="border-b border-line px-4 py-3 md:px-6">
          <OpenQuestions ds={ds ?? []} choices={choices} updating={updating?.decisionId} />
        </div>
      )}
      <Story d={d} flash={flash} conv={conv} />
      {!updating && suggestions.length > 0 && (
        <div className="space-y-2 px-4 md:px-6">
          {suggestions.map((a) => <ActionCard key={a.id} a={a} operator={canAct(user, [d.repo])} editInstructions={user.role === "operator"} className="" item={{ repo: d.repo, number: d.number }} />)}
        </div>
      )}
      <SimilarCard repo={d.repo} number={d.number} />
      {conv && (
        <Composer flush repo={d.repo} number={d.number} operator={user.role === "operator"} commenter={canComment(user)} exists={conv.exists} pending={conv.pending} feedbackOn={open.length === 1 ? open[0] : undefined} choices={choices} opusTurns={opusTurns} />
      )}
    </div>
  );
}
