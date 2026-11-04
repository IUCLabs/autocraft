// Home page: what is wrong, what is running and what just happened, on one screen.
import { BroadcastIcon } from "@phosphor-icons/react";
import { useQuery } from "../../api/client";
import type { FeatureModule, ViewProps } from "../../registry/types";
import { useNow } from "../../lib/useNow";
import { EventRow } from "../../ui/molecules/EventRow";
import { RunningRow } from "../../ui/molecules/RunningRow";
import { HealthStrip } from "../../ui/organisms/HealthStrip";
import { Block, ErrorLine, Page } from "../admin/parts";

function NowView(_: ViewProps) {
  const q = useQuery("now", (api) => api.now());
  const d = q.data;
  useNow(d?.running.length ? 1000 : undefined);
  return (
    <Page title="Now">
      <ErrorLine error={q.error && !d ? q.error.message : null} className="mt-3" />
      {!d && !q.error && <p className="mt-6 text-sm text-ink/50">Loading…</p>}
      {d && (
        <div className="mt-4 space-y-4">
          <HealthStrip health={d.health} />
          <Block flush title={<>Running <span className="num ml-1 font-normal text-ink/50">{d.running.length}</span></>}>
            {d.running.length === 0 ? <p className="p-4 text-sm text-ink/55">Nothing is running.</p> : <ul>{d.running.map((r) => <RunningRow key={r.key} row={r} />)}</ul>}
          </Block>
          <Block flush title="Just happened">
            {d.recent.length === 0 ? <p className="p-4 text-sm text-ink/55">Nothing yet.</p> : <ul>{d.recent.map((e) => <EventRow key={e.key} ev={e} />)}</ul>}
          </Block>
        </div>
      )}
    </Page>
  );
}

export const nowModule: FeatureModule = {
  id: "now",
  permission: "viewer",
  nav: { label: "Now", icon: BroadcastIcon, to: "/" },
  commands: [{ id: "go-now", keys: "g h", label: "Go to Now (home)", group: "Go to" }],
  routes: [{ path: "/", view: { id: "now", title: "Now", panels: [{ id: "main", title: "Now", component: NowView, defaultSize: 100 }] } }],
  prefetch: (api) => void api.now(),
};
