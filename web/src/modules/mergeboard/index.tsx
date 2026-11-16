import type { FeatureModule } from "../../registry/types";
import { lazyView } from "../../registry/lazyView";
import { GitMergeIcon } from "@phosphor-icons/react";

const MergeBoardView = lazyView(() => import("./views"), "MergeBoardView");

export const mergeBoardModule: FeatureModule = {
  id: "merge-board",
  permission: "viewer",
  nav: { label: "Merge queue", icon: GitMergeIcon, to: "/merge" },
  commands: [{ id: "go-merge", keys: "g m", label: "Go to merge queue", group: "Go to" }],
  routes: [{ path: "merge", view: { id: "merge-board", title: "Merge queue", panels: [{ id: "main", title: "Merge queue", component: MergeBoardView, defaultSize: 100 }] } }],
};
