import type { FeatureModule } from "../../registry/types";
import { lazyView } from "../../registry/lazyView";

const FindingView = lazyView(() => import("./views"), "FindingView");

export const securityModule: FeatureModule = {
  id: "security",
  permission: "staff",
  routes: [{ path: "security/:repo/:number", permission: "staff", view: { id: "security-finding", title: "Finding", panels: [{ id: "main", title: "Finding", component: FindingView, defaultSize: 100 }] } }],
};
