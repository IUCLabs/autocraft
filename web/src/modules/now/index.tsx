import type { FeatureModule } from "../../registry/types";
import { lazyView } from "../../registry/lazyView";
import { BroadcastIcon } from "@phosphor-icons/react";

const NowView = lazyView(() => import("./views"), "NowView");

export const nowModule: FeatureModule = {
  id: "now",
  permission: "viewer",
  nav: { label: "Now", icon: BroadcastIcon, to: "/" },
  commands: [{ id: "go-now", keys: "g h", label: "Go to Now (home)", group: "Go to" }],
  routes: [{ path: "/", view: { id: "now", title: "Now", phone: NowView, panels: [{ id: "main", title: "Now", component: NowView, defaultSize: 100 }] } }],
  prefetch: (api) => void api.now(),
};
