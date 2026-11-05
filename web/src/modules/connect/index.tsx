import type { FeatureModule } from "../../registry/types";
import { lazyView } from "../../registry/lazyView";
import { PlugsConnectedIcon } from "@phosphor-icons/react";

const ConnectView = lazyView(() => import("./views"), "ConnectView");

/** Agent tokens for the Inbox MCP server: anyone signed in can connect their own agent. */
export const connectModule: FeatureModule = {
  id: "connect",
  permission: "viewer",
  nav: { label: "Connect agent", icon: PlugsConnectedIcon, to: "/connect" },
  commands: [],
  routes: [{ path: "connect", view: { id: "connect", title: "Connect your agent", panels: [{ id: "main", title: "Connect your agent", component: ConnectView, defaultSize: 100 }] } }],
};
