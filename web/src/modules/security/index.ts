import type { FeatureModule } from "../../registry/types";
import { ShieldWarningIcon } from "@phosphor-icons/react";
import { lazyView } from "../../registry/lazyView";

const FindingView = lazyView(() => import("./views"), "FindingView");
const ScansView = lazyView(() => import("./scanViews"), "ScansView");
const ScanView = lazyView(() => import("./scanViews"), "ScanView");

export const securityModule: FeatureModule = {
  id: "security",
  permission: "staff",
  nav: { label: "Deep scans", icon: ShieldWarningIcon, to: "/security/scans" },
  routes: [
    { path: "security/scans", permission: "staff", view: { id: "security-scans", title: "Deep scans", panels: [{ id: "main", title: "Deep scans", component: ScansView, defaultSize: 100 }] } },
    { path: "security/scans/:id", permission: "staff", view: { id: "security-scan", title: "Deep scan", panels: [{ id: "main", title: "Deep scan", component: ScanView, defaultSize: 100 }] } },
    { path: "security/:repo/:number", permission: "staff", view: { id: "security-finding", title: "Finding", panels: [{ id: "main", title: "Finding", component: FindingView, defaultSize: 100 }] } }],
};
