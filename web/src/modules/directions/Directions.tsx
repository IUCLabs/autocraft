import { useState } from "react";
import { Link } from "react-router-dom";
import { CheckIcon, PlusIcon, XIcon } from "@phosphor-icons/react";
import { useApi, useQuery } from "../../api/client";
import type { DirectionProposal, DirectionView, RepoName } from "../../api/types";
import { useWrite } from "../../lib/hooks";
import { useUser } from "../../shell/UserContext";
import { Badge } from "../../ui/atoms/Badge";
import { Button } from "../../ui/atoms/Button";
import { ErrorLine } from "../../ui/atoms/ErrorLine";
import { Count } from "../../ui/atoms/Heading";
import { Textarea } from "../../ui/atoms/Textarea";
import { TimeAgo } from "../../ui/atoms/TimeAgo";
import { ItemRef } from "../../ui/molecules/ItemRef";
import { decisionPath } from "../../lib/links";
import { Block } from "../../ui/molecules/Block";
import { ConfirmButton } from "../../ui/molecules/ConfirmButton";

const decisionLink = (id: string) => `/decisions/${encodeURIComponent(id)}`;

/** The item a decision is about, as a full item reference that opens the decision. */
function SourceRef({ d }: { d: DirectionView }) {
  const id = d.sourceDecision!, it = d.sourceItem;
  if (!it) return <Link to={decisionLink(id)} className="code hover:text-accent-ink hover:underline">{id}</Link>;
  const kind = id.split(":")[1];
  return <ItemRef repo={it.repo} number={it.number} kind={it.kind} state={it.state} title={it.title} size="sm" className="w-full" href={decisionPath({ id, repo: it.repo, number: it.number, kind })} />;
}

function Row({ d, write }: { d: DirectionView; write: ReturnType<typeof useWrite> }) {
  const api = useApi();
  const operator = useUser().role === "operator";
  const [text, setText] = useState<string | null>(null);
  const key = `direction:${d.id}`;
  return (
    <li className="border-b border-line px-4 py-3 last:border-0">
      {text === null ? (
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm">{d.text}</p>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink/50">
              {d.repo === "*" && <Badge>All repos</Badge>}
              <span>{d.createdBy}</span>
              <TimeAgo iso={d.createdAt} />
              {d.sourceDecision && <SourceRef d={d} />}
            </p>
          </div>
          {operator && !d.retiredAt && (
            <span className="flex shrink-0 items-center gap-1">
              <Button size="sm" variant="ghost" className="max-md:h-11" onClick={() => setText(d.text)}>
                Edit
              </Button>
              <ConfirmButton label="Retire" confirmLabel="Retire the direction" loading={write.busy === key} onConfirm={() => void write.run(key, () => api.directions.retire(d.id))} />
            </span>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <Textarea aria-label="Direction text" rows={3} value={text} onChange={(e) => setText(e.target.value)} />
          <div className="flex gap-2">
            <Button size="sm" variant="primary" icon={CheckIcon} disabled={!text.trim()} loading={write.busy === key} onClick={() => void write.run(key, () => api.directions.edit(d.id, text)).then((ok) => ok && setText(null))}>
              Save
            </Button>
            <Button size="sm" variant="ghost" icon={XIcon} onClick={() => setText(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

/** An open draft from an operator's note: editable text, Accept or Dismiss. */
export function ProposalCard({ p, write, showRepo }: { p: DirectionProposal; write: ReturnType<typeof useWrite>; showRepo?: boolean }) {
  const api = useApi();
  const [text, setText] = useState(p.draft);
  const [all, setAll] = useState(false);
  const key = `proposal:${p.id}`;
  return (
    <li className="flex flex-col gap-2 border-b border-line px-4 py-3 last:border-0">
      <p className="text-xs text-ink/55">
        {showRepo && <span className="mr-2 font-medium">{p.repo}</span>}
        {p.decisionId ? (
          <Link to={decisionLink(p.decisionId)} className="hover:text-accent-ink hover:underline">
            “{p.note}”
          </Link>
        ) : (
          <>“{p.note}”</>
        )}
      </p>
      <Textarea aria-label="Draft direction" rows={2} value={text} onChange={(e) => setText(e.target.value)} />
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="primary" icon={CheckIcon} disabled={!text.trim()} loading={write.busy === key} onClick={() => void write.run(key, () => api.directions.acceptProposal(p.id, { text, allRepos: all }))}>
          Accept
        </Button>
        <Button size="sm" variant="ghost" icon={XIcon} disabled={write.busy === key} onClick={() => void write.run(key, () => api.directions.dismissProposal(p.id))}>
          Dismiss
        </Button>
        <label className="ml-auto flex items-center gap-1.5 text-xs text-ink/60">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
          All repos
        </label>
      </div>
    </li>
  );
}

function AddForm({ repo, write }: { repo: RepoName; write: ReturnType<typeof useWrite> }) {
  const api = useApi();
  const [text, setText] = useState("");
  const [all, setAll] = useState(false);
  return (
    <div className="flex flex-col gap-2 border-t border-line px-4 py-3">
      <Textarea aria-label="New direction" rows={2} value={text} onChange={(e) => setText(e.target.value)} />
      <div className="flex items-center gap-3">
        <Button size="sm" variant="primary" icon={PlusIcon} disabled={!text.trim()} loading={write.busy === "add"} onClick={() => void write.run("add", () => api.directions.add(repo, { text, allRepos: all })).then((ok) => ok && (setText(""), setAll(false)))}>
          Add
        </Button>
        <label className="flex items-center gap-1.5 text-xs text-ink/60">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
          All repos
        </label>
      </div>
    </div>
  );
}

/** The repo page's Directions section: active list, open proposals and retired ones (collapsed). Operators edit; others read. */
export function DirectionsSection({ repo }: { repo: RepoName }) {
  const operator = useUser().role === "operator";
  const write = useWrite();
  const { data, error } = useQuery(`directions:${repo}`, (a) => a.directions.get(repo));
  if (!data) return error ? <ErrorLine error={error.message} className="mt-4" /> : null;
  return (
    <Block className="mt-4" flush title={<>Directions <Count n={data.directions.length} className="ml-1" /></>}>
      <ErrorLine error={write.error} className="px-4 pt-3" />
      {data.proposals.length > 0 && (
        <ul className="border-b border-line bg-accent/[0.04]">
          {data.proposals.map((p) => (
            <ProposalCard key={p.id} p={p} write={write} />
          ))}
        </ul>
      )}
      {data.directions.length > 0 && (
        <ul>
          {data.directions.map((d) => (
            <Row key={d.id} d={d} write={write} />
          ))}
        </ul>
      )}
      {operator && <AddForm repo={repo} write={write} />}
      {data.retired.length > 0 && (
        <details className="border-t border-line">
          <summary className="cursor-pointer px-4 py-2 text-xs text-ink/55">
            Retired <Count n={data.retired.length} className="ml-1" />
          </summary>
          <ul className="opacity-70">
            {data.retired.map((d) => (
              <Row key={d.id} d={d} write={write} />
            ))}
          </ul>
        </details>
      )}
    </Block>
  );
}

/** The open drafts from the answer note of one decision; nothing for others than operators. */
export function DecisionProposals({ decisionId }: { decisionId: string }) {
  const write = useWrite();
  const { data } = useQuery(`directions:decision:${decisionId}`, (a) => a.directions.forDecision(decisionId));
  if (!data?.proposals.length) return null;
  return (
    <section className="mt-4 overflow-hidden rounded-md border border-line">
      <ErrorLine error={write.error} className="px-4 pt-3" />
      <ul>
        {data.proposals.map((p) => (
          <ProposalCard key={p.id} p={p} write={write} />
        ))}
      </ul>
    </section>
  );
}
