import type { FeatureModule } from "../../registry/types";
import { lazyView } from "../../registry/lazyView";
import { ListChecksIcon } from "@phosphor-icons/react";

const NextView = lazyView(() => import("./views"), "NextView");

export const nextModule: FeatureModule = {
  id: "next",
  permission: "viewer",
  nav: { label: "Queue", icon: ListChecksIcon, to: "/next" },
  commands: [{ id: "go-next", keys: "g n", label: "Go to next", group: "Go to" }],
  routes: [{ path: "next/:tab?", view: { id: "next", title: "Next", panels: [{ id: "main", title: "Next", component: NextView, defaultSize: 100 }] } }],
};
