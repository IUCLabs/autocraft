// The one list of feature modules. Adding a feature means adding its module here;
// the shell builds nav, routes, panels and shortcut help from these declarations.
import type { FeatureModule } from "./types";
import { decisionsModule } from "../modules/decisions";
import { itemModule } from "../modules/item";
import { progressModule } from "../modules/progress";
import { itemsModule } from "../modules/items";
import { classifiersModule } from "../modules/classifiers";
import { costModule } from "../modules/cost";
import { accessModule, contributorsModule, reposModule } from "../modules/admin";
import { aboutModule } from "../modules/about";

export const modules: FeatureModule[] = [decisionsModule, itemModule, progressModule, itemsModule, contributorsModule, classifiersModule, costModule, reposModule, accessModule, aboutModule];
