// The one list of feature modules. Adding a feature means adding its module here;
// the shell builds nav, routes, panels and shortcut help from these declarations.
import type { FeatureModule } from "./types";
import { decisionsModule } from "../modules/decisions";
import { flowModule } from "../modules/flow";
import { itemModule } from "../modules/item";
import { progressModule } from "../modules/progress";
import { itemsModule } from "../modules/items";
import { classifiersModule } from "../modules/classifiers";
import { costModule } from "../modules/cost";
import { accessModule, contributorsModule, reposModule } from "../modules/admin";
import { aboutModule } from "../modules/about";
import { pipelineModule } from "../modules/pipeline";
import { promptsModule } from "../modules/prompts";
import { agentsModule } from "../modules/agents";
import { envsModule } from "../modules/envs";
import { ratesModule } from "../modules/rates";
import { queueModule } from "../modules/queue";
import { similarModule } from "../modules/similar";

export const modules: FeatureModule[] = [flowModule, decisionsModule, queueModule, agentsModule, envsModule, ratesModule, itemModule, progressModule, itemsModule, contributorsModule, classifiersModule, costModule, reposModule, accessModule, aboutModule, pipelineModule, promptsModule, similarModule];
