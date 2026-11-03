import { useEffect, useState } from "react";
import { ScrollIcon } from "@phosphor-icons/react";
import { useQuery } from "../../api/client";
import type { AuditEntry } from "../../api/types";
import type { FeatureModule } from "../../registry/types";
import { Button } from "../../ui/atoms/Button";
import { Count } from "../../ui/atoms/Heading";
import { useIsPhone } from "../../shell/useMedia";
import { Block, ErrorLine, Page, Pager, selectCls, SortTh, TextInput, useUrlState, when } from "./parts";

const AUDIT_PAGE = 50;

function AuditView() {
  return (
    <Page title="Audit" sub="Every change on the dashboard">
      <AuditLog />
    </Page>
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

export const auditModule: FeatureModule = {
  id: "audit",
  permission: "staff",
  nav: { label: "Audit", icon: ScrollIcon, to: "/audit", group: "operator", order: 22 },
  routes: [{ path: "audit", permission: "staff", view: { id: "audit", title: "Audit", panels: [{ id: "main", title: "Audit", component: AuditView, defaultSize: 100 }] } }],
};
