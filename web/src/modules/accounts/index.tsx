// Claude accounts: sign-in state, login end date and plan use for everyone;
// operators add accounts, sign them in with a code, sign out, enable and refresh.
import { useState } from "react";
import { KeyRoundIcon } from "lucide-react";
import { Dialog } from "radix-ui";
import { useApi, useQuery } from "../../api/client";
import type { ClaudeAccount } from "../../api/types";
import type { FeatureModule } from "../../registry/types";
import { usePoll } from "../../lib/usePoll";
import { ago } from "../../lib/format";
import { useUser } from "../../shell/UserContext";
import { Badge } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import { cn } from "../../ui/cn";
import { UsageBar } from "../agents/accounts";
import { Block, ConfirmButton, ErrorLine, Page, TextInput, useWrite, when } from "../admin/parts";

const useList = () => useQuery<ClaudeAccount[]>("accounts-page", (a) => a.accounts.list());

function LoginDialog({ a, onClose }: { a: ClaudeAccount; onClose: () => void }) {
  const api = useApi();
  const write = useWrite();
  const [code, setCode] = useState("");
  const q = useQuery<ClaudeAccount[]>("accounts-login", (x) => x.accounts.list());
  usePoll(q.refetch, 2000);
  const login = q.data?.find((x) => x.id === a.id)?.login ?? a.login;
  const state = login?.state ?? "starting";
  const status = { starting: "Starting…", waiting: "Waiting for the code", checking: "Checking the code…", done: "Signed in", failed: login?.message ?? "Sign-in failed", cancelled: "Cancelled" }[state];
  const ended = state === "done" || state === "failed" || state === "cancelled";
  const close = () => {
    if (!ended) void api.accounts.loginCancel(a.id).catch(() => {});
    onClose();
  };
  return (
    <Dialog.Root open onOpenChange={(o) => !o && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(28rem,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-line bg-panel p-4" aria-describedby={undefined}>
          <Dialog.Title className="text-sm font-semibold">Sign in {a.label}</Dialog.Title>
          <div className="mt-3 space-y-3">
            {login?.url && !ended && (
              <a href={login.url} target="_blank" rel="noreferrer noopener" className="block text-sm text-accent underline">
                Open sign-in page
              </a>
            )}
            <form
              className="flex items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void write.run("code", () => api.accounts.loginCode(a.id, code.trim())).then((ok) => ok && (setCode(""), q.refetch()));
              }}
            >
              <label className="flex grow flex-col gap-1 text-xs text-ink/60">
                Code
                <TextInput value={code} autoComplete="off" spellCheck={false} onChange={(e) => setCode(e.target.value)} disabled={state !== "waiting"} className="text-ink" />
              </label>
              <Button type="submit" variant="primary" size="sm" disabled={state !== "waiting" || !code.trim()} loading={write.busy === "code"} className="max-md:h-11">
                Submit
              </Button>
            </form>
            <p className={cn("text-sm", state === "failed" ? "text-bad" : state === "done" ? "text-ok" : "text-ink/70")} role="status">
              {status}
            </p>
            <ErrorLine error={write.error} />
          </div>
          <div className="mt-4 flex justify-end">
            <Button size="sm" variant="ghost" onClick={close} className="max-md:h-11">
              {ended ? "Close" : "Cancel"}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Row({ a, operator, onChanged }: { a: ClaudeAccount; operator: boolean; onChanged: () => void }) {
  const api = useApi();
  const write = useWrite();
  const [signing, setSigning] = useState(false);
  const act = (key: string, f: () => Promise<unknown>) => void write.run(key, f).then((ok) => ok && onChanged());
  const exp = a.auth.expiresAt ? Date.parse(a.auth.expiresAt) : null;
  return (
    <li className={cn("min-w-0 rounded-md border border-line p-4", !a.enabled && "bg-ink/[0.02]")}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">{a.label}</h3>
        <Badge tone={a.enabled ? "ok" : "neutral"}>{a.enabled ? "Enabled" : "Disabled"}</Badge>
        <Badge tone={a.auth.loggedIn ? "ok" : a.auth.loggedIn === false ? "warn" : "neutral"}>{a.auth.loggedIn ? "Signed in" : a.auth.loggedIn === false ? "Signed out" : "Not checked"}</Badge>
        {a.auth.plan && <Badge>{a.auth.plan}</Badge>}
      </div>
      <div className="mt-3 space-y-3">
        <UsageBar label="5-hour use" pct={a.usage.fiveHourPct} resetsAt={a.usage.fiveHourResetsAt} />
        <UsageBar label="Weekly use" pct={a.usage.weeklyPct} resetsAt={a.usage.weeklyResetsAt} />
      </div>
      <dl className="num mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-xs">
        <dt className="text-ink/55">Method</dt>
        <dd>{a.auth.method ?? "–"}</dd>
        <dt className="text-ink/55">Login expires</dt>
        <dd className={cn(exp !== null && exp < Date.now() + 7 * 86_400_000 && "text-warn")}>{when(a.auth.expiresAt)}</dd>
        <dt className="text-ink/55">Status read</dt>
        <dd>{a.auth.checkedAt ? ago(a.auth.checkedAt, false) : "never"}</dd>
        <dt className="text-ink/55">Usage read</dt>
        <dd>{a.usage.readAt ? ago(a.usage.readAt, false) : "never"}</dd>
      </dl>
      {operator && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
          <Button size="sm" variant="primary" icon={KeyRoundIcon} loading={write.busy === "login"} className="max-md:h-11"
            onClick={() => act("login", async () => { await api.accounts.loginStart(a.id); setSigning(true); })}>
            Sign in
          </Button>
          {a.auth.loggedIn && <ConfirmButton label="Sign out" confirmLabel="Confirm sign out" loading={write.busy === "out"} onConfirm={() => act("out", () => api.accounts.signOut(a.id))} />}
          <Button size="sm" variant="ghost" loading={write.busy === "enabled"} className="max-md:h-11" onClick={() => act("enabled", () => api.accounts.update(a.id, { enabled: !a.enabled }))}>
            {a.enabled ? "Disable" : "Enable"}
          </Button>
          <Button size="sm" variant="ghost" loading={write.busy === "refresh"} className="max-md:h-11" onClick={() => act("refresh", () => api.accounts.refresh(a.id))}>
            Refresh
          </Button>
          <ErrorLine error={write.error} className="basis-full" />
        </div>
      )}
      {signing && <LoginDialog a={a} onClose={() => { setSigning(false); onChanged(); }} />}
    </li>
  );
}

function AddForm({ onAdded }: { onAdded: () => void }) {
  const api = useApi();
  const write = useWrite();
  const [label, setLabel] = useState("");
  return (
    <form
      className="mb-4 flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void write.run("add", () => api.accounts.add(label.trim())).then((ok) => ok && (setLabel(""), onAdded()));
      }}
    >
      <label className="flex flex-col gap-1 text-xs text-ink/60">
        Label
        <TextInput value={label} maxLength={40} onChange={(e) => setLabel(e.target.value)} className="w-56 text-ink" />
      </label>
      <Button type="submit" variant="primary" size="sm" disabled={!label.trim()} loading={write.busy === "add"} className="max-md:h-11">
        Add account
      </Button>
      <ErrorLine error={write.error} className="basis-full" />
    </form>
  );
}

function AccountsView() {
  const q = useList();
  usePoll(q.refetch, 30_000);
  const operator = useUser().role === "operator";
  return (
    <Page title="Accounts" sub="Claude accounts for agent runs">
      <div className="mt-4">
        <Block title="Claude accounts">
          <ErrorLine error={q.error?.message} />
          {operator && <AddForm onAdded={q.refetch} />}
          {q.data && q.data.length === 0 && <p className="text-sm text-ink/55">No account yet.</p>}
          {q.data && (
            <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {q.data.map((a) => (
                <Row key={a.id} a={a} operator={operator} onChanged={q.refetch} />
              ))}
            </ul>
          )}
        </Block>
      </div>
    </Page>
  );
}

export const accountsModule: FeatureModule = {
  id: "accounts",
  permission: "viewer",
  nav: { label: "Accounts", icon: KeyRoundIcon, to: "/accounts", group: "operator", order: 7 },
  routes: [{ path: "accounts", view: { id: "accounts", title: "Accounts", panels: [{ id: "main", title: "Accounts", component: AccountsView, defaultSize: 100 }] } }],
};
