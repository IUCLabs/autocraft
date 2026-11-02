// The one list of feature modules. Adding a feature means adding its module here;
// the shell builds nav, routes, panels and shortcut help from these declarations.
import type { FeatureModule } from "./types";
import { decisionsModule } from "../modules/decisions";
import { itemModule } from "../modules/item";
import { progressModule } from "../modules/progress";
import { classifiersModule } from "../modules/classifiers";
import { costModule } from "../modules/cost";
import { placeholderModules } from "../modules/placeholders";

export const modules: FeatureModule[] = [decisionsModule, itemModule, progressModule, classifiersModule, costModule, ...placeholderModules];
