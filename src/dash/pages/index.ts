// The server-rendered pages the React app (web/) doesn't have yet, and the
// whitelist writes. Handlers are pure functions of (db, req).
import { reposRoutes } from "../repos-page.ts";
import type { Route } from "../types.ts";
import { contributorsPage, override, rule } from "./contributors.ts";

export const routes: Route[] = [
  { method: "GET", pattern: "/contributors", handler: contributorsPage },
  { method: "POST", pattern: "/contributors/override", operator: true, handler: override },
  { method: "POST", pattern: "/contributors/rule", operator: true, handler: rule },
  ...reposRoutes,
];
