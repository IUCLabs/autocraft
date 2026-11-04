import type { FeatureModule } from "../../registry/types";
import { lazyView } from "../../registry/lazyView";
import { ListIcon } from "@phosphor-icons/react";

const ItemsView = lazyView(() => import("./views"), "ItemsView");

export const itemsModule: FeatureModule = {
  id: "items",
  permission: "viewer",
  nav: { label: "Items", icon: ListIcon, to: "/items" },
  commands: [{ id: "go-items", keys: "g i", label: "Go to items", group: "Go to" }],
  routes: [{ path: "items", view: { id: "items", title: "Items", panels: [{ id: "main", title: "Items", component: ItemsView, defaultSize: 100 }] } }],
};
