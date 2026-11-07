import type { FeatureModule } from "../../registry/types";
import { lazyView } from "../../registry/lazyView";
import { HouseIcon } from "@phosphor-icons/react";

const HomeView = lazyView(() => import("./views"), "HomeView");

export const homeModule: FeatureModule = {
  id: "home",
  permission: "viewer",
  nav: { label: "Home", icon: HouseIcon, to: "/" },
  commands: [{ id: "go-home", keys: "g h", label: "Go to Home", group: "Go to" }],
  routes: [{ path: "/", view: { id: "home", title: "Home", phone: HomeView, panels: [{ id: "main", title: "Home", component: HomeView, defaultSize: 100 }] } }],
  prefetch: (api) => void api.home(),
};
