import { GaugeIcon, TerminalWindowIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { useApi, useQuery } from "../../api/client";
import type { HelperReadiness, LoginScopes, Machine, RunnerInfo, UsageWindow } from "../../api/types";
import { Badge, type Tone } from "../../ui/atoms/Badge";
import { Button } from "../../ui/atoms/Button";
import { EmptyState } from "../../ui/atoms/EmptyState";
import { ErrorLine } from "../../ui/atoms/ErrorLine";
import { Input } from "../../ui/atoms/Input";
import { Switch } from "../../ui/atoms/Switch";
import { TimeAgo } from "../../ui/atoms/TimeAgo";
import { Block } from "../../ui/molecules/Block";
import { CheckRow } from "../../ui/molecules/CheckRow";
import { ConfirmButton } from "../../ui/molecules/ConfirmButton";
import { clock, day, nowMs } from "../../lib/format";
import { useWrite } from "../../lib/hooks";
import { SectionTitle } from "./SectionTitle";

/** A runner made this recently carries a "new" badge, so one the user did not add stands out. */
const NEW_MS = 24 * 3600_000;

const PLATFORMS: Record<string, string> = { darwin: "macOS", linux: "Linux", win32: "Windows" };
const platform = (p: string) => PLATFORMS[p] ?? p;
const machineText = (m: Machine) => `${m.hostname} · ${platform(m.platform)} ${m.arch}`;

const readinessBadge = (h: RunnerInfo): { text: string; tone: Tone } => {
  if (!h.readiness) return { text: "No status yet", tone: "neutral" };
  if (!h.fresh) return { text: "Not running", tone: "neutral" };
  const until = (word: string) => `${word}${h.until ? ` until ${clock(h.until)}` : ""}`;
  const map: Record<HelperReadiness, { text: string; tone: Tone }> = {
    ready: { text: "Ready", tone: "ok" },
    "quota-held": { text: until("Holding"), tone: "warn" },
    paused: { text: until("Paused"), tone: "warn" },
    "cooled-off": { text: until("Cooling off"), tone: "warn" },
    "sandbox-failed": { text: "Sandbox check failed", tone: "bad" },
    "version-refused": { text: "Runner too old", tone: "bad" },
    "harness-missing": { text: "Harness missing", tone: "bad" },
    failing: { text: until("Calls failing"), tone: "bad" },
  };
  return map[h.readiness];
};

const used = (w: UsageWindow | null | undefined) => (w ? `${Math.round(w.usedPercent)}%` : "–");

const AGENT = "Agent access";
const ANSWER = "Can answer decisions and approve merges";
/** Answering works only through agent access: ticking it ticks agent access, and unticking agent access unticks it. */
const withAgent = (s: LoginScopes, agent: boolean): LoginScopes => ({ agent, answer: agent && s.answer });
const withAnswer = (s: LoginScopes, answer: boolean): LoginScopes => ({ agent: s.agent || answer, answer });

/** The user's Task Runners, and the approval of a device login (`?runner=CODE`, or a typed code). */
export function Runners() {
  const [sp, setSp] = useSearchParams();
  const code = sp.get("runner")?.trim() || null;
  const setCode = (c: string | null) => {
    const next = new URLSearchParams(sp);
    if (c) next.set("runner", c);
    else next.delete("runner");
    setSp(next, { replace: true });
  };
  const { data, error } = useQuery("runners", (a) => a.runners.list());
  const [typed, setTyped] = useState("");
  return (
    <Block className="mt-4" flush title={<SectionTitle icon={TerminalWindowIcon}>Task Runners</SectionTitle>} aside={data ? String(data.runners.length) : undefined}>
      {code ? (
        <ApprovalCard key={code} code={code} answering={!!data?.answering} onDone={() => setCode(null)} />
      ) : (
        <form
          className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (typed.trim()) setCode(typed.trim().toUpperCase());
            setTyped("");
          }}
        >
          <Input value={typed} onChange={(e) => setTyped(e.target.value)} maxLength={12} placeholder="Code, e.g. BCDF-GHJK" aria-label="Task Runner code" autoCapitalize="characters" autoComplete="off" spellCheck={false} className="code min-w-[10rem] flex-1 sm:max-w-[14rem]" />
          <Button type="submit" disabled={!typed.trim()}>
            Look up
          </Button>
        </form>
      )}
      <ErrorLine error={error?.message} className="px-4 pt-3" />
      {data && !data.runners.length && <EmptyState>No Task Runners yet.</EmptyState>}
      {data && data.runners.length > 0 && (
        <ul>
          {data.runners.map((r) => (
            <RunnerRow key={r.tokenId} r={r} answering={data.answering} />
          ))}
        </ul>
      )}
    </Block>
  );
}

function RunnerRow({ r, answering }: { r: RunnerInfo; answering: boolean }) {
  const api = useApi();
  const write = useWrite();
  const b = readinessBadge(r);
  const isNew = nowMs() - Date.parse(r.createdAt) < NEW_MS;
  const setScopes = (s: LoginScopes) => void write.run("scopes", () => api.runners.setScopes(r.tokenId, s));
  return (
    <li className="flex items-start gap-3 border-b border-line px-4 py-2.5 last:border-0">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-medium">
            {r.label ?? `Runner ${r.tokenId}`}
            {isNew && (
              <Badge tone="accent" className="ml-2">
                new
              </Badge>
            )}
          </span>
          <Badge tone={b.tone} icon={<span className="inline-block size-1.5 rounded-full bg-current" />}>
            {b.text}
          </Badge>
          {r.harness && (
            <span className="text-sm text-ink/70">
              {r.harness}
              {r.models.top ? ` · ${r.models.top}` : ""}
            </span>
          )}
          {r.fresh && r.slots !== null && r.busy !== null && (
            <span className="num text-sm text-ink/70" title="Calls running now, of the calls the runner runs at once">
              {r.busy} of {r.slots} busy
            </span>
          )}
          {r.usage && (
            <span className="num text-sm text-ink/70" title="Plan used: 5-hour window, weekly">
              <GaugeIcon className="mr-1 inline" />
              5h {used(r.usage.fiveHour)} · week {used(r.usage.weekly)}
            </span>
          )}
        </div>
        <div className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-ink/55">
          {r.machine && <span>{machineText(r.machine)}</span>}
          {r.helperVersion && <span className="num">{r.helperVersion}</span>}
          <span>{r.lastSeen ? <>seen <TimeAgo iso={r.lastSeen} /></> : "never seen"}</span>
          <span>expires {day(r.expiresAt)}</span>
        </div>
        <div className="mt-1.5 flex flex-wrap gap-x-5 gap-y-1 text-sm text-ink/80">
          <span className="flex items-center gap-2">
            <Switch on={r.agent} onChange={(on) => setScopes(withAgent(r, on))} label={AGENT} busy={write.busy === "scopes"} />
            {AGENT}
          </span>
          {(answering || r.answer) && (
            <span className="flex items-center gap-2">
              <Switch on={r.answer} onChange={(on) => setScopes(withAnswer(r, on))} label={ANSWER} busy={write.busy === "scopes"} />
              {ANSWER}
            </span>
          )}
        </div>
        {r.fresh && r.readiness !== "ready" && r.reason && <p className="mt-1 text-sm text-ink/65">{r.reason}</p>}
        {r.lastError && (
          <p className="mt-1 break-words text-sm text-bad">
            {r.lastError.text} <TimeAgo iso={r.lastError.at} className="text-ink/55" />
          </p>
        )}
        <ErrorLine error={write.error} className="mt-1" />
      </div>
      <ConfirmButton label="Revoke" confirmLabel="Revoke now" loading={write.busy === "revoke"} onConfirm={() => void write.run("revoke", () => api.runners.revoke(r.tokenId))} />
    </li>
  );
}

function ApprovalCard({ code, answering, onDone }: { code: string; answering: boolean; onDone: () => void }) {
  const api = useApi();
  const write = useWrite();
  const { data, error } = useQuery(`runner-pending:${code}`, (a) => a.runners.pending(code));
  const [label, setLabel] = useState<string | null>(null);
  const [elsewhere, setElsewhere] = useState(false);
  const [ticks, setTicks] = useState<LoginScopes | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const shown = data !== undefined;
  useEffect(() => {
    if (shown) ref.current?.scrollIntoView({ block: "nearest" });
  }, [shown]);
  if (data === undefined)
    return error ? (
      <div className="flex items-center gap-3 border-b border-line px-4 py-3">
        <ErrorLine error={error.message} className="flex-1" />
        <Button variant="ghost" onClick={onDone}>Close</Button>
      </div>
    ) : null;
  if (data === null)
    return (
      <div ref={ref} className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
        <p className="flex-1 text-sm">
          No Task Runner login is waiting under <span className="code">{code}</span>.
        </p>
        <Button variant="ghost" onClick={onDone}>Close</Button>
      </div>
    );
  const differ = data.ip !== data.yourIp;
  const name = label ?? data.label;
  const scopes = ticks ?? { agent: data.scopes.agent, answer: answering && data.scopes.answer };
  const approve = () =>
    void write.run("approve", async () => {
      await api.runners.approve(code, name.trim() && name.trim() !== data.label ? name.trim() : undefined, { agent: scopes.agent, answer: answering && scopes.answer }, differ && elsewhere);
      onDone();
    });
  const deny = () =>
    void write.run("deny", async () => {
      await api.runners.deny(code);
      onDone();
    });
  const row = (term: string, value: ReactNode) => (
    <>
      <dt className="text-ink/60">{term}</dt>
      <dd className="min-w-0 break-words">{value}</dd>
    </>
  );
  return (
    <div ref={ref} className="space-y-3 border-b border-line bg-accent/[0.04] px-4 py-3">
      <p className="text-md font-medium">
        Add Task Runner '{data.label}' on {data.machine.hostname} ({platform(data.machine.platform)})?
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        {row("Version", <span className="num">{data.helperVersion}</span>)}
        {row("Started", <span className="num">{clock(data.startedAt)} · <TimeAgo iso={data.startedAt} /></span>)}
        {row("Requested from", <span className="code">{data.ip}</span>)}
        {row(
          "This browser",
          <span className="flex flex-wrap items-center gap-2">
            <span className="code">{data.yourIp}</span>
            {differ && <Badge tone="warn">different address</Badge>}
          </span>,
        )}
        {row("Code expires", <span className="num">{clock(data.expiresAt)}</span>)}
        <dt className="self-center text-ink/60">Label</dt>
        <dd className="mt-1 min-w-0">
          <Input value={name} onChange={(e) => setLabel(e.target.value)} maxLength={60} aria-label="Task Runner label" className="w-full sm:max-w-xs" />
        </dd>
      </dl>
      <div>
        <CheckRow checked={scopes.agent} onChange={(on) => setTicks(withAgent(scopes, on))} title={AGENT} />
        {answering && <CheckRow checked={scopes.answer} onChange={(on) => setTicks(withAnswer(scopes, on))} title={ANSWER} />}
      </div>
      {differ && <CheckRow checked={elsewhere} onChange={setElsewhere} title="I started this on another machine" />}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" disabled={differ && !elsewhere} loading={write.busy === "approve"} onClick={approve}>
          Approve
        </Button>
        <Button loading={write.busy === "deny"} onClick={deny}>
          Deny
        </Button>
      </div>
      <ErrorLine error={write.error} />
    </div>
  );
}
