import { useEffect, useState } from "react";
import { ShieldIcon } from "lucide-react";
import { useApi, useQuery } from "../../api/client";
import type { AccessEntry, AuditEntry, Role, SessionInfo } from "../../api/types";
import type { FeatureModule, ViewProps } from "../../registry/types";
import { Avatar } from "../../ui/Avatar";
import { Badge } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import { cn } from "../../ui/cn";
import { Count } from "../../ui/Heading";
import { ago } from "../../lib/format";
import { useIsPhone } from "../../shell/useMedia";
import { Block, ConfirmButton, ErrorLine, Page, Pager, ROLE_LABEL, ROLES, selectCls, SortTh, TextInput, useUrlState, useWrite, when } from "./parts";
import { useNow } from "../../lib/useNow";

const AUDIT_PAGE = 50;

function AccessView({ user }: ViewProps) {
  const { data, error } = useQuery("access", (api) => api.access.overview());
  return (
    <Page title="Access" sub="Who can sign in, their sessions, and every change on the dashboard">
      <ErrorLine error={error?.message} className="mt-3" />
      {data && (
        <>
          <AccessList entries={data.entries} me={user.login} />
          <Sessions sessions={data.sessions} />
        </>
      )}
      <AuditLog />
    </Page>
  );
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

function AccessList({ entries, me }: { entries: AccessEntry[]; me: string }) {
  const api = useApi();
  const write = useWrite();
  const phone = useIsPhone();
  const [login, setLogin] = useState("");
  const [role, setRole] = useState<Role>("viewer");
  const [note, setNote] = useState("");
  const counts = ROLES.map((r) => plural(entries.filter((e) => e.role === r).length, r)).join(", ");
  const add = () =>
    void write.run("add", () => api.access.add({ login: login.trim(), role, note: note.trim() || undefined })).then((ok) => {
      if (!ok) return;
      setLogin("");
      setNote("");
      setRole("viewer");
    });

  return (
    <Block className="mt-4" flush title={<span className="flex items-center gap-2">Access list <Count n={entries.length} /></span>} aside={`${counts}. Removing a login or changing its role ends its sessions.`}>
      <form
        className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (login.trim()) add();
        }}
      >
        <TextInput value={login} onChange={(e) => setLogin(e.target.value)} placeholder="GitHub login" aria-label="GitHub login" className="w-full sm:w-44" />
        <select aria-label="Role" value={role} onChange={(e) => setRole(e.target.value as Role)} className={selectCls}>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </select>
        <TextInput value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="Note, seen only by operators" aria-label="Note" className="min-w-[12rem] flex-1" />
        <Button type="submit" variant="primary" disabled={!login.trim()} loading={write.busy === "add"} className="max-md:h-11">
          Add
        </Button>
      </form>
      <ErrorLine error={write.error} className="px-4 pt-3" />
      {phone ? (
        <ul>
          {entries.map((e) => (
            <li key={e.login} className="border-b border-line px-4 py-2.5 last:border-0">
              <div className="flex items-center gap-2">
                <Who login={e.login} me={me} />
                <span className="ml-auto" />
                <RolePicker e={e} write={write} />
              </div>
              <div className="mt-1 text-xs text-ink/55">
                Added {when(e.addedAt).slice(0, 10)} by {e.addedBy ?? "–"} · {plural(e.sessions, "session")}
              </div>
              {e.note && <div className="mt-0.5 text-xs text-ink/65">{e.note}</div>}
              <div className="mt-1 flex justify-end">
                <Remove e={e} write={write} />
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] border-collapse text-sm">
            <thead className="bg-ink/[0.03] text-xs">
              <tr className="border-b border-line">
                <SortTh>Login</SortTh>
                <SortTh className="w-[150px]">Role</SortTh>
                <SortTh className="w-[230px]">Added</SortTh>
                <SortTh>Note</SortTh>
                <SortTh right className="w-[80px]">Sessions</SortTh>
                <th className="w-[170px]" aria-label="Remove" />
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.login} className="h-10 border-b border-line last:border-0 hover:bg-ink/[0.03]">
                  <td className="px-3">
                    <Who login={e.login} me={me} />
                  </td>
                  <td className="px-3">
                    <RolePicker e={e} write={write} />
                  </td>
                  <td className="num whitespace-nowrap px-3 text-ink/65">
                    {when(e.addedAt).slice(0, 10)} by {e.addedBy ?? "–"}
                  </td>
                  <td className="max-w-[320px] truncate px-3 text-ink/70" title={e.note ?? undefined}>
                    {e.note ?? ""}
                  </td>
                  <td className="num px-3 text-right">{e.sessions || <span className="text-ink/30">–</span>}</td>
                  <td className="px-3 text-right">
                    <Remove e={e} write={write} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Block>
  );
}

function Who({ login, me }: { login: string; me: string }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <Avatar login={login} size={18} />
      <span className="truncate font-medium">{login}</span>
      {login.toLowerCase() === me.toLowerCase() && <Badge>you</Badge>}
    </span>
  );
}

type Write = ReturnType<typeof useWrite>;

function RolePicker({ e, write }: { e: AccessEntry; write: Write }) {
  const api = useApi();
  return (
    <select
      aria-label={`Role of ${e.login}`}
      value={e.role}
      disabled={write.busy === `role:${e.login}`}
      onChange={(ev) => void write.run(`role:${e.login}`, () => api.access.setRole(e.login, ev.target.value as Role))}
      className={cn(selectCls, "h-7 text-xs", e.role === "operator" && "text-accent-ink")}
    >
      {ROLES.map((r) => (
        <option key={r} value={r}>
          {ROLE_LABEL[r]}
        </option>
      ))}
    </select>
  );
}

function Remove({ e, write }: { e: AccessEntry; write: Write }) {
  const api = useApi();
  return (
    <ConfirmButton
      label="Remove"
      confirmLabel={`Remove ${e.login}`}
      loading={write.busy === `remove:${e.login}`}
      onConfirm={() => void write.run(`remove:${e.login}`, () => api.access.remove(e.login))}
    />
  );
}

/** "Safari on iPhone" from a user agent string. */
function browser(ua: string | null): string {
  if (!ua) return "Unknown browser";
  const b = /Firefox\//.test(ua) ? "Firefox" : /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${b} on ${os}` : b;
}

function Sessions({ sessions }: { sessions: SessionInfo[] }) {
  useNow();
  const api = useApi();
  const write = useWrite();
  const phone = useIsPhone();
  const revoke = (s: SessionInfo) => (
    <ConfirmButton
      label="Revoke"
      confirmLabel={s.current ? "Sign me out" : "Revoke session"}
      loading={write.busy === `revoke:${s.id}`}
      onConfirm={() => void write.run(`revoke:${s.id}`, () => api.access.revokeSession(s.id))}
    />
  );
  return (
    <Block className="mt-4" flush title={<span className="flex items-center gap-2">Active sessions <Count n={sessions.length} /></span>} aside="Sessions last 14 days from the last visit">
      <ErrorLine error={write.error} className="px-4 pt-3" />
      {sessions.length === 0 && <p className="px-4 py-6 text-sm text-ink/50">No active sessions.</p>}
      {phone ? (
        <ul>
          {sessions.map((s) => (
            <li key={s.id} className="flex items-center gap-3 border-b border-line px-4 py-2.5 last:border-0">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{s.login}</span>
                  {s.current && <Badge tone="accent">this session</Badge>}
                </div>
                <div className="mt-0.5 text-xs text-ink/55">
                  {browser(s.userAgent)} · seen {ago(s.lastSeen, false)}
                </div>
              </div>
              {revoke(s)}
            </li>
          ))}
        </ul>
      ) : (
        sessions.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] border-collapse text-sm">
              <thead className="bg-ink/[0.03] text-xs">
                <tr className="border-b border-line">
                  <SortTh>Login</SortTh>
                  <SortTh className="w-[170px]">Browser</SortTh>
                  <SortTh className="w-[150px]">Signed in (UTC)</SortTh>
                  <SortTh className="w-[150px]">Last seen</SortTh>
                  <SortTh className="w-[150px]">Expires (UTC)</SortTh>
                  <th className="w-[160px]" aria-label="Revoke" />
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <tr key={s.id} className="h-10 border-b border-line last:border-0 hover:bg-ink/[0.03]">
                    <td className="px-3">
                      <span className="flex items-center gap-2">
                        <Avatar login={s.login} size={18} />
                        <span className="font-medium">{s.login}</span>
                        {s.current && <Badge tone="accent">this session</Badge>}
                      </span>
                    </td>
                    <td className="px-3 text-ink/70" title={s.userAgent ?? undefined}>
                      {browser(s.userAgent)}
                    </td>
                    <td className="num whitespace-nowrap px-3 text-ink/65">{when(s.createdAt)}</td>
                    <td className="px-3 text-ink/65" title={when(s.lastSeen)}>
                      {ago(s.lastSeen, false)}
                    </td>
                    <td className="num whitespace-nowrap px-3 text-ink/65">{when(s.expiresAt)}</td>
                    <td className="px-3 text-right">{revoke(s)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </Block>
  );
}

// Rows written before the role was renamed say "admin" for operator.
const ROLE_KEYS = new Set(["role", "from", "to"]);
const detailValue = (k: string, v: unknown) => (ROLE_KEYS.has(k) && v === "admin" ? "operator" : typeof v === "object" ? JSON.stringify(v) : String(v));

const detailText = (d: AuditEntry["details"]) =>
  d
    ? Object.entries(d)
        .filter(([, v]) => v !== null && v !== undefined)
        .map(([k, v]) => `${k}: ${detailValue(k, v)}`)
        .join(" · ")
    : "";

function AuditLog() {
  const { state, update } = useUrlState();
  const offset = Math.max(0, Number(state.offset) || 0);
  const filter = { login: state.login || undefined, action: state.action || undefined, limit: AUDIT_PAGE, offset };
  const { data, error } = useQuery(`audit:${JSON.stringify(filter)}`, (api) => api.access.audit(filter));
  const [login, setLogin] = useState(state.login ?? "");
  useEffect(() => setLogin(state.login ?? ""), [state.login]);
  const phone = useIsPhone();

  return (
    <Block className="mt-4" flush title={<span className="flex items-center gap-2">Audit log <Count n={data?.total} /></span>} aside="Newest first; times in UTC">
      <form
        className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3"
        onSubmit={(e) => {
          e.preventDefault();
          update({ login: login.trim() || null, offset: null });
        }}
      >
        <TextInput value={login} onChange={(e) => setLogin(e.target.value)} placeholder="Login (by or about)" aria-label="Filter by login" className="w-full sm:w-52" />
        <select aria-label="Filter by action" value={state.action ?? ""} onChange={(e) => update({ action: e.target.value || null, offset: null })} className={selectCls}>
          <option value="">Every action</option>
          {data?.actions.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <Button type="submit" className="max-md:h-11">
          Filter
        </Button>
        {(state.login || state.action) && (
          <Button type="button" variant="ghost" className="max-md:h-11" onClick={() => update({ login: null, action: null, offset: null })}>
            Clear
          </Button>
        )}
      </form>
      <ErrorLine error={error?.message} className="px-4 pt-3" />
      {data && data.entries.length === 0 && <p className="px-4 py-6 text-sm text-ink/50">No entries match.</p>}
      {data &&
        data.entries.length > 0 &&
        (phone ? (
          <ul>
            {data.entries.map((e, i) => (
              <li key={i} className="border-b border-line px-4 py-2 last:border-0">
                <div className="flex items-baseline gap-2 text-sm">
                  <span className="font-medium">{e.login}</span>
                  <span className="code text-ink/75">{e.action}</span>
                  <span className="num ml-auto text-xs text-ink/50">{when(e.at)}</span>
                </div>
                {(e.target || e.details) && (
                  <div className="mt-0.5 break-words text-xs text-ink/55">
                    {e.target && <span className="code">{e.target}</span>} {detailText(e.details)}
                  </div>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] border-collapse text-sm">
              <thead className="bg-ink/[0.03] text-xs">
                <tr className="border-b border-line">
                  <SortTh className="w-[150px]">When</SortTh>
                  <SortTh className="w-[150px]">By</SortTh>
                  <SortTh className="w-[140px]">Action</SortTh>
                  <SortTh className="w-[240px]">Target</SortTh>
                  <SortTh>Details</SortTh>
                </tr>
              </thead>
              <tbody>
                {data.entries.map((e, i) => (
                  <tr key={i} className="h-8 border-b border-line last:border-0 hover:bg-ink/[0.03]">
                    <td className="num whitespace-nowrap px-3 text-ink/65">{when(e.at)}</td>
                    <td className="px-3">
                      <button className="hover:text-accent-ink hover:underline" onClick={() => update({ login: e.login, offset: null })}>
                        {e.login}
                      </button>
                    </td>
                    <td className="code px-3 text-ink/80">{e.action}</td>
                    <td className="code max-w-[240px] truncate px-3 text-ink/70" title={e.target ?? undefined}>
                      {e.target ?? ""}
                    </td>
                    <td className="max-w-[360px] truncate px-3 text-xs text-ink/55" title={detailText(e.details)}>
                      {detailText(e.details)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      {data && <Pager offset={offset} limit={AUDIT_PAGE} total={data.total} onOffset={(o) => update({ offset: o ? String(o) : null })} />}
    </Block>
  );
}

export const accessModule: FeatureModule = {
  id: "access",
  permission: "operator",
  nav: { label: "Access", icon: ShieldIcon, to: "/access", group: "operator", order: 21 },
  routes: [{ path: "access", permission: "operator", view: { id: "access", title: "Access", panels: [{ id: "main", title: "Access", component: AccessView, defaultSize: 100 }] } }],
};
