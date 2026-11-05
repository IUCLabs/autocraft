import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowUUpLeftIcon, BookmarkSimpleIcon, GitMergeIcon, MegaphoneIcon, ProhibitIcon, ShieldCheckIcon, WrenchIcon } from "@phosphor-icons/react";
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import { useApi, useQuery } from "../../api/client";
import type { FindingAction, FindingView as Finding } from "../../api/types";
import type { ViewProps } from "../../registry/types";
import { useWrite } from "../../lib/hooks";
import { githubBlobUrl } from "../../lib/links";
import { FINDING_STATE, SEVERITY, findingActions } from "../../lib/security";
import { formatCost } from "../../lib/trace";
import { Badge } from "../../ui/atoms/Badge";
import { Button } from "../../ui/atoms/Button";
import { ErrorLine } from "../../ui/atoms/ErrorLine";
import { Pending } from "../../ui/atoms/Pending";
import { Textarea } from "../../ui/atoms/Textarea";
import { TimeAgo } from "../../ui/atoms/TimeAgo";
import { Block } from "../../ui/molecules/Block";
import { CodeBlock } from "../../ui/molecules/CodeBlock";
import { useUser } from "../../shell/UserContext";

const ACTION: Record<FindingAction, { label: string; icon: PhosphorIcon; primary?: boolean }> = {
  fix: { label: "Fix", icon: WrenchIcon, primary: true },
  dismiss: { label: "Dismiss", icon: ProhibitIcon },
  backlog: { label: "Backlog", icon: BookmarkSimpleIcon },
  reopen: { label: "Reopen", icon: ArrowUUpLeftIcon, primary: true },
  land: { label: "Land", icon: GitMergeIcon, primary: true },
  advisory: { label: "Advisory", icon: MegaphoneIcon, primary: true },
  publish: { label: "Publish", icon: ShieldCheckIcon, primary: true },
};

const CALL = { model: "Threat model", area: "Area scan", verify: "Verification" } as const;

function Actions({ f }: { f: Finding }) {
  const api = useApi();
  const write = useWrite();
  const [dismissing, setDismissing] = useState(false);
  const [reason, setReason] = useState("");
  const actions = findingActions(f);
  if (!actions.length) return null;
  const run = (a: FindingAction, why?: string) => write.run(a, () => api.security.act(f.repo, f.number, a, why));
  return (
    <div className="mt-4">
      <div className="flex flex-wrap gap-2">
        {actions.map((a) => {
          const { label, icon, primary } = ACTION[a];
          return (
            <Button key={a} icon={icon} variant={primary ? "primary" : "secondary"} loading={write.busy === a} disabled={!!write.busy} className="max-md:h-11 max-md:flex-1" onClick={() => (a === "dismiss" ? setDismissing(!dismissing) : void run(a))}>
              {label}
            </Button>
          );
        })}
      </div>
      {dismissing && (
        <form
          className="mt-3 flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run("dismiss", reason.trim()).then((ok) => ok && setDismissing(false));
          }}
        >
          <Textarea aria-label="Reason" placeholder="Reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
          <Button type="submit" className="self-end max-md:h-11 max-md:w-full" disabled={!reason.trim()} loading={write.busy === "dismiss"}>
            Dismiss finding
          </Button>
        </form>
      )}
      <ErrorLine error={write.error} className="mt-2" />
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-5">
      <h2 className="mb-1 text-sm font-semibold">{title}</h2>
      <p className="whitespace-pre-wrap break-words text-sm text-ink/85 [overflow-wrap:anywhere]">{children}</p>
    </section>
  );
}

export function FindingView({ params }: ViewProps) {
  const repo = params.repo!;
  const n = Number(params.number);
  const role = useUser().role;
  const { data: f, error } = useQuery(`security-finding:${repo}#${n}`, (a) => a.security.finding(repo, n), { enabled: role !== "viewer" });
  const { data: ov } = useQuery(`security:${repo}`, (a) => a.security.overview(repo), { enabled: role !== "viewer" });
  if (!f) return <Pending error={error} />;
  const commit = ov?.scans.find((x) => x.id === f.scanId)?.commit ?? null;
  const sev = SEVERITY[f.severity];
  const st = FINDING_STATE[f.state];
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[920px] px-4 pb-12 pt-5 md:px-6">
        <div className="mb-1 flex flex-wrap items-center gap-x-2 text-sm text-ink/60">
          <Link to={`/repos/${encodeURIComponent(f.repo)}`} className="hover:text-accent-ink hover:underline">{f.repo}</Link>
          <span className="code">finding {f.number}</span>
        </div>
        <h1 className="text-xl font-semibold">{f.title}</h1>
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-sm text-ink/60">
          <Badge tone={sev.tone}>{sev.label}</Badge>
          <Badge tone={st.tone}>{st.label}</Badge>
          {f.urgent && <Badge tone="bad">Urgent</Badge>}
          <span className="code">{f.area}</span>
          <span>
            Found <TimeAgo iso={f.createdAt} />
          </span>
          {f.fixPr && <span className="code">PR {f.fixPr}</span>}
          {f.ghsaId && <span className="code">{f.ghsaId}</span>}
        </div>
        {f.reason && <p className="mt-3 text-sm text-ink/70">{f.decidedBy}: {f.reason}</p>}
        <Actions f={f} />
        <h2 className="mb-1 mt-5 text-sm font-semibold">Code</h2>
        <ul className="flex flex-col">
          {f.refs.map((r) => (
            <li key={`${r.path}:${r.line}`}>
              {commit ? (
                <a href={githubBlobUrl(f.repo, commit, r.path, r.line)} target="_blank" rel="noopener noreferrer" className="code block break-all py-1 text-sm text-accent-ink hover:underline max-md:py-2.5">
                  {r.path}:{r.line}
                </a>
              ) : (
                <span className="code block break-all py-1 text-sm max-md:py-2.5">{r.path}:{r.line}</span>
              )}
              {r.claim && <span className="block text-xs text-ink/60">{r.claim}</span>}
            </li>
          ))}
        </ul>
        <Section title="How untrusted input reaches the code">{f.reach}</Section>
        <Section title="Impact">{f.impact}</Section>
        {f.verification && (
          <section className="mt-5">
            <h2 className="mb-1 text-sm font-semibold">Verification</h2>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge tone={f.verification.kind === "test" ? "ok" : "neutral"}>{f.verification.kind === "test" ? "Test" : "Reasoning"}</Badge>
              {f.verification.score !== null && <Badge tone={f.verification.score >= 8 ? "ok" : "warn"}><span className="num">{f.verification.score}/10</span></Badge>}
              <span>{f.verification.result}</span>
            </div>
            {f.verification.notes && <p className="mt-1 whitespace-pre-wrap break-words text-sm text-ink/70 [overflow-wrap:anywhere]">{f.verification.notes}</p>}
            {f.verification.proposedTest && <CodeBlock className="mt-2" title="Proposed test" text={f.verification.proposedTest} lines={12} />}
          </section>
        )}
        {f.fixDiff && <CodeBlock className="mt-5" title="Fix" text={f.fixDiff} lines={20} />}
        {f.timeline.length > 0 && (
          <Block className="mt-6" flush title="Model calls">
            <ul>
              {f.timeline.map((c, i) => (
                <li key={i} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 border-b border-line px-4 py-2.5 text-sm last:border-0">
                  <span>{CALL[c.kind]}</span>
                  {!c.ok && <Badge tone="bad">Failed</Badge>}
                  <TimeAgo iso={c.at} className="num text-xs text-ink/55" />
                  {formatCost(c.costUsd) && <span className="num ml-auto text-xs text-ink/60" title="Model cost">{formatCost(c.costUsd)}</span>}
                </li>
              ))}
            </ul>
          </Block>
        )}
      </div>
    </div>
  );
}
