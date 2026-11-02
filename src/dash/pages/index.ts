// The server-rendered pages the React app (web/) doesn't have yet. Handlers
// are pure functions of (db, req).
import type { Route } from "../types.ts";
import { classifiers, disagreements } from "./classifiers.ts";
import { cost } from "./cost.ts";

export const routes: Route[] = [
  { method: "GET", pattern: "/classifiers", handler: classifiers },
  { method: "GET", pattern: "/classifiers/items", handler: disagreements },
  { method: "GET", pattern: "/cost", handler: cost },
];
