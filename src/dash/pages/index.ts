// Every dashboard page except Access. Handlers are pure functions of (db, req).
import type { Route } from "../types.ts";
import { classifiers, disagreements } from "./classifiers.ts";
import { contributorsPage, override, rule } from "./contributors.ts";
import { cost } from "./cost.ts";
import { answer, answeredTab, home, undo } from "./decisions.ts";
import { item } from "./item.ts";
import { progress, repo } from "./progress.ts";

export const routes: Route[] = [
  { method: "GET", pattern: "/", handler: home },
  { method: "GET", pattern: "/answered", handler: answeredTab },
  { method: "POST", pattern: "/decisions/answer", handler: answer },
  { method: "POST", pattern: "/decisions/undo", handler: undo },
  { method: "GET", pattern: "/progress", handler: progress },
  { method: "GET", pattern: "/repo/:name", handler: repo },
  { method: "GET", pattern: "/item/:repo/:n", handler: item },
  { method: "GET", pattern: "/contributors", handler: contributorsPage },
  { method: "POST", pattern: "/contributors/override", admin: true, handler: override },
  { method: "POST", pattern: "/contributors/rule", admin: true, handler: rule },
  { method: "GET", pattern: "/classifiers", handler: classifiers },
  { method: "GET", pattern: "/classifiers/items", handler: disagreements },
  { method: "GET", pattern: "/cost", handler: cost },
];
