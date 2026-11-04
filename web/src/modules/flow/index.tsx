import type { FeatureModule } from "../../registry/types";
import { lazyView } from "../../registry/lazyView";

const FlowView = lazyView(() => import("./views"), "FlowView");

export const flowModule: FeatureModule = {
  id: "flow",
  permission: "viewer",
  routes: [{ path: "flow", view: { id: "flow", title: "Pipeline flow", slots: ["flow.panel"], panels: [{ id: "main", title: "Pipeline flow", component: FlowView, defaultSize: 100 }] } }],
  prefetch: (api) => void api.flow(),
};
