import { TrayIcon } from "@phosphor-icons/react";
import { useQuery } from "../../api/client";
import type { FeatureModule } from "../../registry/types";
import { InboxList } from "./InboxList";
import { DetailPanel } from "./DecisionDetail";
import { ThreadPanel } from "./Thread";
import { PhoneInbox } from "./PhoneInbox";
import { DecisionsToolbar } from "./Toolbar";

function useWaitingCount() {
  return useQuery("count:open", (api) => api.decisions.list({ status: "open", limit: 0 })).data?.total;
}

export const decisionsModule: FeatureModule = {
  id: "decisions",
  permission: "viewer",
  nav: { label: "Decisions", icon: TrayIcon, to: "/decisions", group: "work", order: 0, phoneTab: true, useBadge: useWaitingCount },
  commands: [{ id: "go-decisions", keys: "g d", label: "Go to decisions", group: "Go to" }],
  routes: [
    {
      path: "decisions/:id?",
      view: {
        id: "decisions",
        title: "Decisions",
        toolbar: DecisionsToolbar,
        phone: PhoneInbox,
        panels: [
          { id: "list", title: "Queue", component: InboxList, defaultSize: 28, minSize: 20, maxSize: 45 },
          { id: "detail", title: "Decision", component: DetailPanel, defaultSize: 45, minSize: 32 },
          { id: "thread", title: "Discussion", component: ThreadPanel, defaultSize: 27, minSize: 18, maxSize: 40, collapsible: true, hideOnPhone: true },
        ],
      },
    },
    {
      path: "decisions/:repo/:n",
      view: {
        id: "decisions",
        title: "Decisions",
        toolbar: DecisionsToolbar,
        phone: PhoneInbox,
        panels: [
          { id: "list", title: "Queue", component: InboxList, defaultSize: 28, minSize: 20, maxSize: 45 },
          { id: "detail", title: "Decision", component: DetailPanel, defaultSize: 45, minSize: 32 },
          { id: "thread", title: "Discussion", component: ThreadPanel, defaultSize: 27, minSize: 18, maxSize: 40, collapsible: true, hideOnPhone: true },
        ],
      },
    },
    {
      path: "decisions/:repo/:n/:kind",
      view: {
        id: "decisions",
        title: "Decisions",
        toolbar: DecisionsToolbar,
        phone: PhoneInbox,
        panels: [
          { id: "list", title: "Queue", component: InboxList, defaultSize: 28, minSize: 20, maxSize: 45 },
          { id: "detail", title: "Decision", component: DetailPanel, defaultSize: 45, minSize: 32 },
          { id: "thread", title: "Discussion", component: ThreadPanel, defaultSize: 27, minSize: 18, maxSize: 40, collapsible: true, hideOnPhone: true },
        ],
      },
    },
  ],
};
