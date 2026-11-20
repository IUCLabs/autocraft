import { GaugeIcon, TerminalWindowIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useApi, useQuery } from "../../api/client";
import type { HelperReadiness, McpToken, RemoteHelper, UsageWindow } from "../../api/types";
import type { ViewProps } from "../../registry/types";
import { Badge, type Tone } from "../../ui/atoms/Badge";
import { Button } from "../../ui/atoms/Button";
import { EmptyState } from "../../ui/atoms/EmptyState";
import { ErrorLine } from "../../ui/atoms/ErrorLine";
import { Input } from "../../ui/atoms/Input";
import { Switch } from "../../ui/atoms/Switch";
import { Th } from "../../ui/atoms/Th";
import { TimeAgo } from "../../ui/atoms/TimeAgo";
import { Block } from "../../ui/molecules/Block";
import { CheckRow } from "../../ui/molecules/CheckRow";
import { CodeBlock } from "../../ui/molecules/CodeBlock";
import { ConfirmButton } from "../../ui/molecules/ConfirmButton";
import { Page } from "../../ui/organisms/Page";
import { useIsPhone } from "../../shell/useMedia";
import { clock, day } from "../../lib/format";
import { useWrite } from "../../lib/hooks";

/** The command that adds the server to Claude Code; other clients take the URL and header the same way. */
const claudeCommand = (url: string, token: string) => `claude mcp add --transport http autocraft-inbox ${url} --header "Authorization: Bearer ${token}"`;
/** The helper's setup, one command per step; `origin` is this dashboard. */
const setupSteps = (origin: string): { title: string; text: string }[] => [
  { title: "1. Install the helper", text: `mkdir -p ~/.local/bin && curl -fsSL ${origin}/worker/autocraft-task.mjs -o ~/.local/bin/autocraft-task && chmod +x ~/.local/bin/autocraft-task` },
  { title: "2. Log in (token on stdin)", text: `autocraft-task login ${origin}` },
  { title: "3. Harness: your Claude Code login (Linux)", text: "autocraft-task harness claude --config-dir" },
  { title: "3. Or, on macOS: your Claude Code login", text: "autocraft-task harness claude --keychain" },
  { title: "3. Or: a long-lived token (on stdin)", text: "claude setup-token\nautocraft-task harness claude" },
  { title: "4. Check the setup", text: "autocraft-task doctor" },
  { title: "5. Work, from a terminal or an agent", text: "autocraft-task work\n\n# or, from an agent\nautocraft-task run --detach\nautocraft-task wait <id>" },
];
const jsonConfig = (url: string, token: string) => JSON.stringify({ mcpServers: { "autocraft-inbox": { type: "http", url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2);

export function ConnectView({ user }: ViewProps) {
  const api = useApi();
  const write = useWrite();
  const { data, error } = useQuery("mcp-tokens", (a) => a.mcp.tokens());
  const [label, setLabel] = useState("");
  const [answer, setAnswer] = useState(false);
  const [runTasks, setRunTasks] = useState(false);
  const [made, setMade] = useState<{ id: number; token: string } | null>(null);
  const url = `${location.origin}${data?.path ?? "/mcp"}`;
  const full = !!data && data.tokens.length >= data.max;
  const viewer = user.role === "viewer";
  const settles = user.role === "operator" || (user.role === "maintainer" && user.maintainerWrites);

  const create = () =>
    void write.run("create", async () => {
      const r = await api.mcp.create(label, settles && !!data?.answering && answer, runTasks);
      setMade({ id: r.id, token: r.token });
      setLabel("");
      setAnswer(false);
      setRunTasks(false);
    });

  return (
    <Page title="Connect your agent" sub="Work the Inbox from Claude Code or any MCP client, on your own machine and account">
      <Block className="mt-4" flush title="Agent tokens" aside={data ? `${data.tokens.length} of ${data.max}` : undefined}>
        {!viewer && <form
          className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3"
          onSubmit={(e) => {
            e.preventDefault();
            create();
          }}
        >
          <Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} placeholder="Label, e.g. laptop" aria-label="Token label" className="min-w-[12rem] flex-1 sm:max-w-xs" />
          {settles && data?.answering && (
            <span className="flex items-center gap-2 text-sm text-ink/80">
              <Switch on={answer} onChange={setAnswer} label="Can answer decisions" />
              Can answer decisions
            </span>
          )}
          <span className="flex items-center gap-2 text-sm text-ink/80">
            <Switch on={runTasks} onChange={setRunTasks} label="Can run tasks" />
            Can run tasks
          </span>
          <Button type="submit" variant="primary" disabled={full} loading={write.busy === "create"} className="max-md:h-11">
            Make a token
          </Button>
          {full && <span className="text-xs text-ink/55">Revoke a token to make another.</span>}
        </form>}
        <ErrorLine error={error?.message ?? write.error} className="px-4 pt-3" />
        {made && (
          <div className="space-y-3 border-b border-line bg-accent/[0.04] px-4 py-3">
            <p className="text-sm font-medium">Copy it now: the token is shown only this once.</p>
            <CodeBlock title="Claude Code" text={claudeCommand(url, made.token)} lines={4} />
            <CodeBlock title="Other MCP clients (JSON config)" text={jsonConfig(url, made.token)} lines={12} />
            <Button size="sm" variant="ghost" onClick={() => setMade(null)}>
              Done
            </Button>
          </div>
        )}
        {data && <Tokens tokens={data.tokens} write={write} fresh={made?.id ?? null} />}
      </Block>
      {!viewer && user.inference === "user-local" && <MySettings />}
      {!viewer && user.inference === "user-local" && <Helpers />}
      {!viewer && user.inference === "user-local" && (
        <Block className="mt-4" title="Run model calls">
          <div className="space-y-3">
            {setupSteps(location.origin).map((s) => (
              <CodeBlock key={s.title} title={s.title} text={s.text} lines={6} />
            ))}
          </div>
        </Block>
      )}
    </Page>
  );
}

function Tokens({ tokens, write, fresh }: { tokens: McpToken[]; write: ReturnType<typeof useWrite>; fresh: number | null }) {
  const api = useApi();
  const phone = useIsPhone();
  if (!tokens.length) return <EmptyState>No tokens yet.</EmptyState>;
  const revoke = (t: McpToken) => (
    <ConfirmButton label="Revoke" confirmLabel="Revoke now" loading={write.busy === `revoke:${t.id}`} onConfirm={() => void write.run(`revoke:${t.id}`, () => api.mcp.revoke(t.id))} />
  );
  const name = (t: McpToken) => (
    <>
      {t.label ?? <span className="text-ink/40">no label</span>}
      {t.canAnswer && <Badge className="ml-2">answers decisions</Badge>}
      {t.canRun && <Badge className="ml-2">runs tasks</Badge>}
      {t.id === fresh && <Badge tone="accent" className="ml-2">new</Badge>}
    </>
  );
  if (phone)
    return (
      <ul>
        {tokens.map((t) => (
          <li key={t.id} className="flex items-center gap-3 border-b border-line px-4 py-2.5 last:border-0">
            <div className="min-w-0 flex-1">
              <div className="font-medium">{name(t)}</div>
              <div className="mt-0.5 text-xs text-ink/55">
                Made {day(t.createdAt)} · {t.lastUsedAt ? <>used <TimeAgo iso={t.lastUsedAt} /></> : "never used"} · expires {day(t.expiresAt)}
              </div>
            </div>
            {revoke(t)}
          </li>
        ))}
      </ul>
    );
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] border-collapse text-sm">
        <thead className="bg-ink/[0.03] text-xs">
          <tr className="border-b border-line">
            <Th>Label</Th>
            <Th className="w-[140px]">Made</Th>
            <Th className="w-[140px]">Last used</Th>
            <Th className="w-[140px]">Expires</Th>
            <th className="w-[120px]" aria-label="Revoke" />
          </tr>
        </thead>
        <tbody>
          {tokens.map((t) => (
            <tr key={t.id} className="h-10 border-b border-line last:border-0 hover:bg-ink/[0.03]">
              <td className="px-3">{name(t)}</td>
              <td className="num whitespace-nowrap px-3 text-ink/65">{day(t.createdAt)}</td>
              <td className="num whitespace-nowrap px-3 text-ink/65">{t.lastUsedAt ? <TimeAgo iso={t.lastUsedAt} /> : "never"}</td>
              <td className="num whitespace-nowrap px-3 text-ink/65">{day(t.expiresAt)}</td>
              <td className="px-3 text-right">
                {revoke(t)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const readinessBadge = (h: RemoteHelper): { text: string; tone: Tone } => {
  if (!h.readiness) return { text: "No status yet", tone: "neutral" };
  if (!h.fresh) return { text: "Not running", tone: "neutral" };
  const until = (word: string) => `${word}${h.until ? ` until ${clock(h.until)}` : ""}`;
  const map: Record<HelperReadiness, { text: string; tone: Tone }> = {
    ready: { text: "Ready", tone: "ok" },
    "quota-held": { text: until("Holding"), tone: "warn" },
    paused: { text: until("Paused"), tone: "warn" },
    "cooled-off": { text: until("Cooling off"), tone: "warn" },
    "sandbox-failed": { text: "Sandbox check failed", tone: "bad" },
    "version-refused": { text: "Helper too old", tone: "bad" },
    "harness-missing": { text: "Harness missing", tone: "bad" },
    failing: { text: until("Calls failing"), tone: "bad" },
  };
  return map[h.readiness];
};

const used = (w: UsageWindow | null | undefined) => (w ? `${Math.round(w.usedPercent)}%` : "–");

function Helpers() {
  const { data } = useQuery("remote-helpers", (a) => a.remote.helpers());
  if (!data?.helpers.length) return null;
  return (
    <Block className="mt-4" flush title="My helpers">
      <ul>
        {data.helpers.map((h) => {
          const b = readinessBadge(h);
          return (
            <li key={h.tokenId} className="border-b border-line px-4 py-2.5 last:border-0">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="min-w-[8rem] font-medium">{h.label ?? `Token ${h.tokenId}`}</span>
                <Badge tone={b.tone} icon={<span className="inline-block size-1.5 rounded-full bg-current" />}>{b.text}</Badge>
                {h.harness && (
                  <span className="flex items-center gap-1 text-sm text-ink/70">
                    <TerminalWindowIcon /> {h.harness}{h.models.top ? ` · ${h.models.top}` : ""}
                  </span>
                )}
                {h.fresh && h.slots !== null && h.busy !== null && (
                  <span className="num text-sm text-ink/70" title="Calls running now, of the calls the helper runs at once">
                    {h.busy} of {h.slots} busy
                  </span>
                )}
                {h.usage && (
                  <span className="num text-sm text-ink/70" title="Plan used: 5-hour window, weekly">
                    <GaugeIcon className="mr-1 inline" />
                    5h {used(h.usage.fiveHour)} · week {used(h.usage.weekly)}
                  </span>
                )}
                {h.lastSeen && (
                  <span className="text-xs text-ink/55 sm:ml-auto">
                    <TimeAgo iso={h.lastSeen} />
                  </span>
                )}
              </div>
              {h.fresh && h.readiness !== "ready" && h.reason && <p className="mt-1 text-sm text-ink/65">{h.reason}</p>}
              {h.lastError && (
                <p className="mt-1 break-words text-sm text-bad">
                  {h.lastError.text} <TimeAgo iso={h.lastError.at} className="text-ink/55" />
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </Block>
  );
}

function MySettings() {
  const api = useApi();
  const write = useWrite();
  const { data, error } = useQuery("my-settings", (a) => a.me.settings.get());
  const [vals, setVals] = useState<{ fiveHour: string; weekly: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [picks, setPicks] = useState<string[]>([]);
  const [maxCalls, setMaxCalls] = useState("");
  useEffect(() => {
    if (!data) return;
    setVals({ fiveHour: String(data.reserve.fiveHour), weekly: String(data.reserve.weekly) });
    setPicks(data.repos);
    setMaxCalls(data.maxCalls === null ? "" : String(data.maxCalls));
  }, [data]);
  if (!data || !vals) return error ? <ErrorLine error={error.message} className="mt-4" /> : null;
  const savePicks = (next: string[]) => {
    const was = picks;
    setPicks(next);
    void write.run("repos", async () => {
      try {
        setPicks((await api.me.settings.put({ repos: next })).repos);
      } catch (e) {
        setPicks(was);
        throw e;
      }
    });
  };
  const choices = new Set(data.repoChoices);
  // Picks that are no longer available (pipeline off, or no write permission) stay listed so they can be removed.
  const shown = [...new Set([...data.repoChoices, ...picks])].sort((x, y) => x.localeCompare(y, undefined, { sensitivity: "base" }));
  const valid = (v: string) => /^\d+$/.test(v) && Number(v) <= 90;
  const save = (next: { fiveHour: string; weekly: string }) => {
    if (!valid(next.fiveHour) || !valid(next.weekly)) {
      setProblem("Enter a whole number from 0 to 90.");
      return;
    }
    setProblem(null);
    const body = { reserve: { fiveHour: Number(next.fiveHour), weekly: Number(next.weekly) } };
    if (body.reserve.fiveHour === data.reserve.fiveHour && body.reserve.weekly === data.reserve.weekly) return;
    void write.run("settings", () => api.me.settings.put(body));
  };
  const validMax = (v: string) => v.trim() === "" || (/^\d+$/.test(v.trim()) && Number(v) >= 1 && Number(v) <= 64);
  const saveMax = (v: string) => {
    if (!validMax(v)) {
      setProblem("Enter a whole number from 1 to 64, or leave it empty for no limit.");
      return;
    }
    setProblem(null);
    const next = v.trim() === "" ? null : Number(v);
    if (next === data.maxCalls) return;
    void write.run("max-calls", () => api.me.settings.put({ maxCalls: next }));
  };
  const field = (key: "fiveHour" | "weekly", label: string) => (
    <label className="flex items-center gap-2 text-sm">
      <span className="w-44 shrink-0 text-ink/80">{label}</span>
      <Input
        type="number"
        inputMode="numeric"
        min={0}
        max={90}
        step={1}
        value={vals[key]}
        invalid={!valid(vals[key])}
        onChange={(e) => {
          const next = { ...vals, [key]: e.target.value };
          setVals(next);
        }}
        onBlur={() => save(vals)}
        onKeyDown={(e) => {
          if (e.key === "Enter") save(vals);
        }}
        aria-label={label}
        className="w-20"
      />
      <span className="text-ink/55">%</span>
    </label>
  );
  return (
    <Block className="mt-4" title="My settings">
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:gap-6">
        {field("fiveHour", "Keep free: 5-hour window")}
        {field("weekly", "Keep free: weekly")}
        <label className="flex items-center gap-2 text-sm">
          <span className="w-44 shrink-0 text-ink/80">Max calls at once</span>
          <Input
            type="number"
            inputMode="numeric"
            min={1}
            max={64}
            step={1}
            placeholder="None"
            value={maxCalls}
            invalid={!validMax(maxCalls)}
            onChange={(e) => setMaxCalls(e.target.value)}
            onBlur={() => saveMax(maxCalls)}
            onKeyDown={(e) => {
              if (e.key === "Enter") saveMax(maxCalls);
            }}
            aria-label="Max calls at once"
            className="w-20"
          />
        </label>
      </div>
      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:gap-2">
        <span className="w-44 shrink-0 pt-1.5 text-sm text-ink/80">My repos</span>
        <div role="group" aria-label="My repos" className="min-w-0 flex-1 rounded-md border border-line sm:max-w-sm">
          <CheckRow checked={!picks.length} onChange={() => picks.length && savePicks([])} title="All repos" />
          {shown.map((r) => {
            const on = picks.includes(r);
            const ok = choices.has(r);
            return (
              <CheckRow
                key={r}
                checked={on}
                onChange={() => savePicks(on ? picks.filter((x) => x !== r) : [...picks, r].sort())}
                title={
                  <span className={ok ? undefined : "line-through opacity-60"} title={ok ? undefined : "Pipeline off or no write permission"}>
                    {r}
                  </span>
                }
              />
            );
          })}
        </div>
      </div>
      <ErrorLine error={problem ?? write.error} className="mt-2" />
    </Block>
  );
}
