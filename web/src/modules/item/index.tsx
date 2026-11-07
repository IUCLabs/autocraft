import type { FeatureModule } from "../../registry/types";
import { lazyView } from "../../registry/lazyView";

const ItemMain = lazyView(() => import("./views"), "ItemMain");
const ItemSide = lazyView(() => import("./views"), "ItemSide");
const ItemPageView = lazyView(() => import("./page/ItemPage"), "ItemPageView");

export const itemModule: FeatureModule = {
  id: "item",
  permission: "viewer",
  routes: [
    { path: "items/:repo/:number", view: { id: "item-page", title: "Item", phone: ItemPageView, panels: [{ id: "main", title: "Item", component: ItemPageView, defaultSize: 100 }] } },
    {
      path: "item/:repo/:number",
      view: {
        id: "item",
        title: "Item",
        slots: ["item.side"],
        panels: [
          { id: "main", title: "Item", component: ItemMain, defaultSize: 72, minSize: 45 },
          { id: "side", title: "Decisions and links", component: ItemSide, defaultSize: 28, minSize: 20, maxSize: 45, collapsible: true },
        ],
      },
    },
  ],
};
