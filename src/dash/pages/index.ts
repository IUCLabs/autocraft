// The server-rendered pages the React app (web/) doesn't have yet, and the
// whitelist writes. Handlers are pure functions of (db, req).
import { reposRoutes } from "../repos-page.ts";
import type { Route } from "../types.ts";
import { classifiers, disagreements } from "./classifiers.ts";
import { contributorsPage, override, rule } from "./contributors.ts";
import { cost } from "./cost.ts";

export const routes: Route[] = [
  { method: "GET", pattern: "/contributors", handler: contributorsPage },
  { method: "POST", pattern: "/contributors/override", operator: true, handler: override },
  { method: "POST", pattern: "/contributors/rule", operator: true, handler: rule },
  { method: "GET", pattern: "/classifiers", handler: classifiers },
  { method: "GET", pattern: "/classifiers/items", handler: disagreements },
  { method: "GET", pattern: "/cost", handler: cost },
  ...reposRoutes,
];
