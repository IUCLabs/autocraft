// Security as a destination: findings grouped by what they need, and the finding page on the item layout.
import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeftIcon, GithubLogoIcon, RobotIcon, ShieldWarningIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useApi, useQuery } from "../../api/client";
import type { FindingAction, FindingPageData, FindingRow } from "../../api/types";
import { Badge } from "../../ui/atoms/Badge";
import { Button } from "../../ui/atoms/Button";
import { ErrorLine } from "../../ui/atoms/ErrorLine";
import { Pending } from "../../ui/atoms/Pending";
import { TimeAgo } from "../../ui/atoms/TimeAgo";
import { CodeBlock } from "../../ui/molecules/CodeBlock";
import { RadioRow } from "../../ui/molecules/RadioRow";
import { Section } from "../../ui/molecules/Section";
import { StatusLine } from "../../ui/molecules/StatusLine";
import { Page } from "../../ui/organisms/Page";
import { cn } from "../../ui/cn";
import { FINDING_STATE, SEVERITY, findingActions } from "../../lib/security";
import { formatCost } from "../../lib/trace";
import { findingPath, githubBlobUrl } from "../../lib/links";
import { useWrite } from "../../lib/hooks";
import { useUser } from "../../shell/UserContext";
import { useIsPhone } from "../../shell/useMedia";
import type { ViewProps } from "../../registry/types";

function Row({ r }: { r: FindingRow }) {
  const sev = SEVERITY[r.severity];
  return (
    <li className="relative border-t border-line py-2.5 hover:bg-ink/[0.025] max-md:py-3">
      <div className="flex items-start gap-2 text-sm">
        <Badge tone={sev.tone} className="mt-px">{sev.label}</Badge>
        <Link to={findingPath(r.repo, r.number)} className="min-w-0 flex-1 break-words after:absolute after:inset-0 hover:underline">
          <span className="code text-ink/60">{r.repo}</span> {r.title}
        </Link>
        <TimeAgo iso={r.updatedAt} className="num shrink-0 pt-px text-xs text-ink/45" />
      </div>
      <div className="mt-1 flex items-start gap-1.5 text-xs leading-5 text-ink/65">
        {r.attempts > 0 && <WarningCircleIcon weight="fill" className="mt-[3px] shrink-0 text-warn" />}
        <StatusLine status={r.status} compact className="min-w-0 flex-1 text-xs" />
      </div>
    </li>
  );
}

export function SecurityListView(_: ViewProps) {
  const { data, error } = useQuery("security-list", (a) => a.securityList());
  return (
    <Page title="Security">
      <div className="mt-3 flex gap-1 border-b border-line text-sm" role="tablist">
        <span role="tab" aria-selected className="-mb-px inline-flex h-9 items-center border-b-2 border-accent px-2 font-medium max-md:h-11">Findings</span>
        <Link role="tab" to="/security/scans" className="inline-flex h-9 items-center px-2 text-ink/60 hover:text-ink max-md:h-11">Scans</Link>
      </div>
      {!data ? <Pending error={error} /> : (
        <div className="mt-5 space-y-7">
          {data.groups.map((g) => (
            <Section key={g.group} title={g.group} count={g.rows.length}>
              <ul>{g.rows.map((r) => <Row key={r.number} r={r} />)}</ul>
            </Section>
          ))}
        </div>
      )}
    </Page>
  );
}

const LABEL: Record<FindingAction, string> = { fix: "Fix", dismiss: "Dismiss", backlog: "Backlog", reopen: "Reopen", land: "Land", advisory: "Advisory", publish: "Publish" };

function Decide({ d }: { d: FindingPageData }) {
  const api = useApi();
  const write = useWrite();
  const f = d.finding;
  const actions = findingActions(f);
  const again = d.attempts > 0;
  const hint: Record<string, string> = { fix: again ? "Another three rounds, with your note passed to the model" : "Opens a private fix, up to three rounds", backlog: "Keep it for later", dismiss: "Not a vulnerability, or not worth fixing", land: "Opens a quiet pull request", advisory: "Private fix through a security advisory", publish: "Publish the advisory", reopen: "Back to a decision" };
  const [pick, setPick] = useState<FindingAction | null>(actions[0] ?? null);
  const [note, setNote] = useState("");
  if (!actions.length) return null;
  return (
    <section className="border-b border-line px-4 pb-4 md:px-6" aria-label="Open question">
      <div className="rounded-md border border-line-strong px-3 py-3 md:px-4">
        <p className="text-[15px] font-semibold leading-6">{again ? "The fix gave up. What next?" : "What should happen to this finding?"}</p>
        <div role="radiogroup" className="mt-2 space-y-0.5">
          {actions.map((a, i) => (
            <RadioRow key={a} selected={pick === a} onSelect={() => setPick(a)} title={<>{a === "fix" && again ? "Fix again with a note" : LABEL[a]} {i === 0 && <Badge tone="accent">Recommended</Badge>}</>}>
              {pick === a && <p className="text-xs text-ink/60">{hint[a]}</p>}
            </RadioRow>
          ))}
        </div>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Add a note (optional)" aria-label="Note" className="mt-2 block w-full resize-none rounded border border-line bg-sunken px-2.5 py-2 text-sm outline-none placeholder:text-ink/40 focus:border-accent/60" />
        <Button variant="primary" className="mt-3 max-md:h-11 max-md:w-full" disabled={!pick || (pick === "dismiss" && !note.trim())} loading={!!write.busy} onClick={() => pick && void write.run(pick, () => api.security.act(f.repo, f.number, pick, note.trim() || undefined))}>Do it</Button>
        <ErrorLine error={write.error} className="mt-2" />
      </div>
    </section>
  );
}

export function FindingPageView({ params }: ViewProps) {
  const repo = params.repo!;
  const n = Number(params.number);
  const role = useUser().role;
  const phone = useIsPhone();
  const [side, setSide] = useState<"autocraft" | "github">("autocraft");
  const { data: d, error } = useQuery(`security-finding-page:${repo}#${n}`, (a) => a.findingPage(repo, n), { enabled: role !== "viewer" });
  if (role === "viewer") return <div className="p-8 text-ink/60">Operators and maintainers only.</div>;
  if (!d) return <Pending error={error} />;
  const f = d.finding;
  const sev = SEVERITY[f.severity];
  const st = FINDING_STATE[f.state];
  const left = <FindingAutoCraft d={d} />;
  const right = (
    <div className="px-4 py-3 md:px-6">
      <div className="text-xs font-semibold text-ink/55"><span className="inline-flex items-center gap-1.5"><GithubLogoIcon className="text-[14px]" /> On GitHub</span></div>
      {f.fixPr && f.fixPrUrl ? (
        <a href={f.fixPrUrl} target="_blank" rel="noopener noreferrer" className="mt-3 block rounded-md border border-line border-l-[3px] border-l-accent px-3 py-2.5 text-sm hover:bg-ink/[0.03]">
          <span className="code text-ink/60">#{f.fixPr}</span> Fix pull request
        </a>
      ) : (
        <p className="mt-3 text-sm text-ink/60">Not on GitHub. The finding stays private until a fix lands.</p>
      )}
    </div>
  );
  return (
    <div className={cn("flex min-h-0 flex-col", "h-full", phone && "overflow-y-auto")}>
      <header className="shrink-0 border-b border-line px-4 pb-3 pt-3 md:px-6">
        <Link to="/security" className="inline-flex h-7 items-center gap-1 text-xs text-ink/60 hover:text-ink max-md:h-11"><ArrowLeftIcon /> Security</Link>
        <h1 className="mt-1 text-lg font-semibold leading-6 md:text-xl md:leading-7">
          <ShieldWarningIcon className="mr-2 inline-block align-[-2px] text-bad" />
          <span className="code mr-2 text-ink/60">{f.repo} finding {f.number}</span>
          {f.title}
        </h1>
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-ink/55">
          <Badge tone={sev.tone}>{sev.label}</Badge>
          <Badge tone={st.tone}>{st.label}</Badge>
          {f.urgent && <Badge tone="bad">Urgent</Badge>}
          <span className="code">{f.area}</span>
        </div>
        <StatusLine status={d.status} className="mt-2.5 rounded bg-ink/[0.04] px-3 py-2" />
      </header>
      {phone ? (
        <>
          <div className="sticky top-0 z-20 flex gap-1 border-b border-line bg-panel px-4 py-2">
            {(["autocraft", "github"] as const).map((s) => <button key={s} role="radio" aria-checked={side === s} data-active={side === s} onClick={() => setSide(s)} className="chip h-9 flex-1 justify-center">{s === "autocraft" ? "AutoCraft" : "GitHub"}</button>)}
          </div>
          {side === "autocraft" ? left : right}
        </>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,11fr)_minmax(0,9fr)]">
          <div className="min-h-0 overflow-y-auto border-r border-line">{left}</div>
          <div className="min-h-0 overflow-y-auto bg-bg/40">{right}</div>
        </div>
      )}
    </div>
  );
}

const sec = "border-b border-line px-4 py-4 md:px-6";
const H = ({ children, aside }: { children: React.ReactNode; aside?: React.ReactNode }) => <div className="mb-2 flex items-baseline gap-2"><h2 className="text-sm font-semibold">{children}</h2>{aside && <span className="ml-auto text-xs text-ink/55">{aside}</span>}</div>;

function FindingAutoCraft({ d }: { d: FindingPageData }) {
  const f = d.finding;
  return (
    <div>
      <div className="px-4 pt-3 text-xs font-semibold text-accent-ink md:px-6"><span className="inline-flex items-center gap-1.5"><RobotIcon /> In AutoCraft</span><span className="num float-right font-normal text-ink/55">{formatCost(d.costUsd)} in all</span></div>
      <div className="pt-3"><Decide d={d} /></div>
      {d.rounds.length > 0 && (
        <section className={sec}>
          <H aside={`${d.attempts} rounds`}>Fix rounds</H>
          <ol className="space-y-2.5">
            {d.rounds.map((r) => (
              <li key={r.round} className="flex items-start gap-2.5 text-sm">
                <Badge tone={r.outcome === "passed" ? "ok" : "bad"} className="mt-px">Round {r.round}</Badge>
                <span className="min-w-0 flex-1 text-ink/85">{r.why}</span>
                <span className="num shrink-0 text-xs text-ink/50">{formatCost(r.costUsd)}</span>
              </li>
            ))}
          </ol>
        </section>
      )}
      <section className={sec}>
        <H>Code</H>
        <ul className="space-y-1.5">
          {f.refs.map((r) => (
            <li key={`${r.path}:${r.line}`} className="text-sm">
              <a href={githubBlobUrl(f.repo, "main", r.path, r.line)} target="_blank" rel="noopener noreferrer" className="code break-all text-accent-ink hover:underline">{r.path}:{r.line}</a>
              {r.claim && <span className="block text-xs text-ink/60">{r.claim}</span>}
            </li>
          ))}
        </ul>
      </section>
      <section className={sec}>
        <H>Reach</H><p className="text-sm leading-6 text-ink/85">{f.reach}</p>
        <div className="mt-4"><H>Impact</H><p className="text-sm leading-6 text-ink/85">{f.impact}</p></div>
      </section>
      {f.verification && (
        <section className={sec}>
          <H>Verification</H>
          <div className="flex flex-wrap items-center gap-2 text-sm"><Badge tone={f.verification.kind === "test" ? "ok" : "neutral"}>{f.verification.kind === "test" ? "Test" : "Reasoning"}</Badge>{f.verification.score !== null && <Badge tone="ok"><span className="num">{f.verification.score}/10</span></Badge>}<span>{f.verification.result}</span></div>
          {f.verification.proposedTest && <CodeBlock className="mt-2" title="Proposed test" text={f.verification.proposedTest} lines={10} />}
        </section>
      )}
      <section className="px-4 py-4 md:px-6">
        <H aside={<span className="num">{formatCost(d.costUsd)}</span>}>History</H>
        <ol>
          {d.history.map((h) => (
            <li key={h.id} className="flex items-start gap-2.5 border-t border-line py-2 text-sm">
              <TimeAgo iso={h.at} className="num w-14 shrink-0 pt-px text-xs text-ink/50" />
              <div className="min-w-0 flex-1"><span className="font-medium">{h.step}</span> <span className="text-ink/70">{h.outcome}</span>{h.model && <div className="text-xs text-ink/50">{h.model}</div>}</div>
              {formatCost(h.costUsd) && <span className="num shrink-0 pt-px text-xs text-ink/55">{formatCost(h.costUsd)}</span>}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
