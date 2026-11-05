import { useState } from "react";
import { useApi, useQuery } from "../../api/client";
import type { McpToken, Role } from "../../api/types";
import type { ViewProps } from "../../registry/types";
import { Button } from "../../ui/atoms/Button";
import { ErrorLine } from "../../ui/atoms/ErrorLine";
import { Input } from "../../ui/atoms/Input";
import { Th } from "../../ui/atoms/Th";
import { TimeAgo } from "../../ui/atoms/TimeAgo";
import { Block } from "../../ui/molecules/Block";
import { CodeBlock } from "../../ui/molecules/CodeBlock";
import { ConfirmButton } from "../../ui/molecules/ConfirmButton";
import { Page } from "../../ui/organisms/Page";
import { day } from "../../lib/format";
import { useWrite } from "../../lib/hooks";

const CAN: Record<Role, string> = {
  operator: "Your agent can read the Inbox and send feedback (a pick and a note) as you. To let it also answer decisions, make a token that answers: the pipeline acts on those answers as on yours, so such a token lasts 7 days.",
  maintainer: "Your agent can read the Inbox and send feedback (a pick and a note) as you. An operator answers; your pick is advice they can use.",
  viewer: "Your role is viewer, which writes nothing, so you cannot make a token. Ask an operator to make you a maintainer to connect your agent.",
};

const ASK = [
  "Connect to the AutoCraft Inbox and check whether there's anything in photocraft we can solve.",
  "Give me 5 PRs that need a fix-up.",
  "Pick the oldest scope decision, check it against the reference app with me, and send what we found.",
];

/** The command that adds the server to Claude Code; other clients take the URL and header the same way. */
const claudeCommand = (url: string, token: string) => `claude mcp add --transport http autocraft-inbox ${url} --header "Authorization: Bearer ${token}"`;
const jsonConfig = (url: string, token: string) => JSON.stringify({ mcpServers: { "autocraft-inbox": { type: "http", url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2);

export function ConnectView({ user }: ViewProps) {
  const api = useApi();
  const write = useWrite();
  const { data, error } = useQuery("mcp-tokens", (a) => a.mcp.tokens());
  const [label, setLabel] = useState("");
  const [answer, setAnswer] = useState(false);
  const [made, setMade] = useState<{ id: number; token: string } | null>(null);
  const url = `${location.origin}${data?.path ?? "/mcp"}`;
  const full = !!data && data.tokens.length >= data.max;
  const viewer = user.role === "viewer";

  const create = () =>
    void write.run("create", async () => {
      const r = await api.mcp.create(label, user.role === "operator" && answer);
      setMade({ id: r.id, token: r.token });
      setLabel("");
      setAnswer(false);
    });

  return (
    <Page title="Connect your agent" sub="Work the Inbox from Claude Code or any MCP client, on your own machine and account">
      <Block className="mt-4" title="How it works">
        <div className="space-y-2 text-sm leading-relaxed text-ink/80">
          <p>
            The Inbox MCP server lists what the pipeline could not settle on its own, across every tracked repo: open decisions, and pull requests whose review fixes it could not apply.
            Your agent picks something up, works it through with you (checking out code, building, comparing with the reference app), and reports back.
          </p>
          <p>{CAN[user.role]}</p>
          <p className="text-ink/60">Everything it reads from GitHub is untrusted text. Review what your agent wants to run before it runs it.</p>
        </div>
      </Block>

      <Block className="mt-4" flush title="Agent tokens" aside={data ? `${data.tokens.length} of ${data.max}. A token works for 90 days or until you revoke it.` : undefined}>
        {!viewer && <form
          className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3"
          onSubmit={(e) => {
            e.preventDefault();
            create();
          }}
        >
          <Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} placeholder="Label, e.g. laptop" aria-label="Token label" className="min-w-[12rem] flex-1 sm:max-w-xs" />
          {user.role === "operator" && (
            <label className="flex items-center gap-2 text-sm text-ink/80" title="The agent can answer decisions and undo answers as you. The pipeline acts on its answers. The token lasts 7 days.">
              <input type="checkbox" checked={answer} onChange={(e) => setAnswer(e.target.checked)} className="size-4" />
              Can answer decisions
            </label>
          )}
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

      <Block className="mt-4" title="Then ask your agent">
        <ul className="list-disc space-y-1 pl-5 text-sm text-ink/80">
          {ASK.map((q) => (
            <li key={q}>{q}</li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-ink/55">
          Server URL: <code className="code">{url}</code>
        </p>
      </Block>
    </Page>
  );
}

function Tokens({ tokens, write, fresh }: { tokens: McpToken[]; write: ReturnType<typeof useWrite>; fresh: number | null }) {
  const api = useApi();
  if (!tokens.length) return <p className="px-4 py-3 text-sm text-ink/55">No tokens yet.</p>;
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
              <td className="px-3">
                {t.label ?? <span className="text-ink/40">no label</span>}
                {t.canAnswer && <span className="ml-2 rounded border border-line px-1.5 py-0.5 text-2xs font-medium text-ink/70">answers decisions</span>}
                {t.id === fresh && <span className="ml-2 text-xs text-accent-ink">new</span>}
              </td>
              <td className="num whitespace-nowrap px-3 text-ink/65">{day(t.createdAt)}</td>
              <td className="num whitespace-nowrap px-3 text-ink/65">{t.lastUsedAt ? <TimeAgo iso={t.lastUsedAt} /> : "never"}</td>
              <td className="num whitespace-nowrap px-3 text-ink/65">{day(t.expiresAt)}</td>
              <td className="px-3 text-right">
                <ConfirmButton label="Revoke" confirmLabel="Revoke now" loading={write.busy === `revoke:${t.id}`} onConfirm={() => void write.run(`revoke:${t.id}`, () => api.mcp.revoke(t.id))} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
