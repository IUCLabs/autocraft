import type { FeatureModule } from "../../registry/types";
import { lazyView } from "../../registry/lazyView";

const SimilarItems = lazyView(() => import("./views"), "SimilarItems");

export const similarModule: FeatureModule = {
  id: "similar",
  permission: "viewer",
  routes: [],
  commands: [{ id: "search-semantic", keys: "alt+m", label: "Search by meaning (in the search box)", group: "Anywhere" }],
  slots: [{ slot: "item.side", order: 10, component: SimilarItems }],
};
