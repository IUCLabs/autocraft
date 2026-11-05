import type { ViewDef } from "../../registry/types";
import { InboxList } from "./InboxList";
import { DetailPanel } from "./DecisionDetail";
import { PhoneInbox } from "./PhoneInbox";
import { DecisionsToolbar } from "./Toolbar";

/** The Decisions tab of the Needs you page. */
export const decisionsView: ViewDef = {
  id: "decisions",
  title: "Decisions",
  toolbar: DecisionsToolbar,
  phone: PhoneInbox,
  panels: [
    { id: "list", title: "Queue", component: InboxList, defaultSize: 32, minSize: 20, maxSize: 45 },
    { id: "detail", title: "Decision", component: DetailPanel, defaultSize: 68, minSize: 40 },
  ],
};
