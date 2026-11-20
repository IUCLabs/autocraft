import { PlugsConnectedIcon, WrenchIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { useApi, useQuery } from "../../api/client";
import type { McpToken } from "../../api/types";
import type { ViewProps } from "../../registry/types";
import { Badge } from "../../ui/atoms/Badge";
import { Button } from "../../ui/atoms/Button";
import { EmptyState } from "../../ui/atoms/EmptyState";
import { ErrorLine } from "../../ui/atoms/ErrorLine";
import { Input } from "../../ui/atoms/Input";
import { Switch } from "../../ui/atoms/Switch";
import { Th } from "../../ui/atoms/Th";
import { TimeAgo } from "../../ui/atoms/TimeAgo";
import { Block } from "../../ui/molecules/Block";
import { CodeBlock } from "../../ui/molecules/CodeBlock";
import { ConfirmButton } from "../../ui/molecules/ConfirmButton";
import { Page } from "../../ui/organisms/Page";
import { useIsPhone } from "../../shell/useMedia";
import { day } from "../../lib/format";
import { useWrite } from "../../lib/hooks";
import { MySettings } from "./MySettings";
import { Runners } from "./Runners";
import { SectionTitle } from "./SectionTitle";

/** The command that adds the MCP Connector to Claude Code; other clients take the URL and header the same way. */
const claudeCommand = (url: string, token: string) => `claude mcp add --transport http autocraft ${url} --header "Authorization: Bearer ${token}"`;
const jsonConfig = (url: string, token: string) => JSON.stringify({ mcpServers: { autocraft: { type: "http", url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2);
/** A Task Runner's setup, one command per step; `origin` is this dashboard. */
const setupSteps = (origin: string): { title: string; text: string }[] => [
  { title: "1. Install", text: `mkdir -p ~/.local/bin && curl -fsSL ${origin}/worker/autocraft.mjs -o ~/.local/bin/autocraft && chmod +x ~/.local/bin/autocraft` },
  { title: "2. Log in and approve the code here", text: `autocraft login ${origin}` },
  { title: "3. Harness: your Claude Code login (Linux)", text: "autocraft harness claude --config-dir" },
  { title: "3. Or, on macOS: your Claude Code login", text: "autocraft harness claude --keychain" },
  { title: "3. Or: a long-lived token (on stdin)", text: "claude setup-token\nautocraft harness claude" },
  { title: "4. Check the setup", text: "autocraft doctor" },
  { title: "5. Run it as a service", text: "autocraft service install" },
  { title: "5. Or work from a terminal or an agent", text: "autocraft work\n\n# or, from an agent\nautocraft run --detach\nautocraft wait <id>" },
];

export function ConnectView({ user }: ViewProps) {
  const local = user.role !== "viewer" && user.inference === "user-local";
  return (
    <Page title="Connect">
      <Connector user={user} />
      {local && <Runners />}
      {local && (
        <Block className="mt-4" title={<SectionTitle icon={WrenchIcon}>Set up a Task Runner</SectionTitle>}>
          <div className="space-y-3">
            {setupSteps(location.origin).map((s) => (
              <CodeBlock key={s.title} title={s.title} text={s.text} lines={6} />
            ))}
          </div>
        </Block>
      )}
      {local && <MySettings />}
    </Page>
  );
}

function Connector({ user }: Pick<ViewProps, "user">) {
  const api = useApi();
  const write = useWrite();
  const { data, error } = useQuery("mcp-tokens", (a) => a.mcp.tokens());
  const [label, setLabel] = useState("");
  const [answer, setAnswer] = useState(false);
  const [made, setMade] = useState<{ id: number; token: string } | null>(null);
  const url = `${location.origin}${data?.path ?? "/mcp"}`;
  const tokens = data?.tokens.filter((t) => t.kind === "connector") ?? [];
  const full = !!data && tokens.length >= data.max;
  const viewer = user.role === "viewer";
  const settles = user.role === "operator" || (user.role === "maintainer" && user.maintainerWrites);

  const create = () =>
    void write.run("create", async () => {
      const r = await api.mcp.create(label, settles && !!data?.answering && answer);
      setMade({ id: r.id, token: r.token });
      setLabel("");
      setAnswer(false);
    });

  return (
    <Block className="mt-4" flush title={<SectionTitle icon={PlugsConnectedIcon}>MCP Connector</SectionTitle>} aside={data ? `${tokens.length} of ${data.max}` : undefined}>
      {!viewer && (
        <form
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
          <Button type="submit" variant="primary" disabled={full} loading={write.busy === "create"}>
            Make a token
          </Button>
          {full && <span className="text-xs text-ink/55">Revoke a token to make another.</span>}
        </form>
      )}
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
      {data && <Tokens tokens={tokens} write={write} fresh={made?.id ?? null} />}
    </Block>
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
