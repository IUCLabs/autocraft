// The one list of feature modules. Adding a feature means adding its module here;
// the shell builds nav, routes, panels and shortcut help from these declarations.
import type { FeatureModule } from "./types";
import { needsModule } from "../modules/needs";
import { flowModule } from "../modules/flow";
import { nowModule } from "../modules/now";
import { itemModule } from "../modules/item";
import { progressModule } from "../modules/progress";
import { itemsModule } from "../modules/items";
import { classifiersModule } from "../modules/classifiers";
import { costModule } from "../modules/cost";
import { accessModule, auditModule, contributorsModule, reposModule } from "../modules/admin";
import { aboutModule } from "../modules/about";
import { pipelineModule } from "../modules/pipeline";
import { promptsModule } from "../modules/prompts";
import { accountsModule } from "../modules/accounts";
import { agentsModule } from "../modules/agents";
import { envsModule } from "../modules/envs";
import { ratesModule } from "../modules/rates";
import { nextModule } from "../modules/next";
import { similarModule } from "../modules/similar";
import { mainCiModule } from "../modules/mainci";
import { activityModule } from "../modules/activity";
import { batchModule } from "../modules/batch";

export const modules: FeatureModule[] = [nowModule, flowModule, needsModule, nextModule, agentsModule, envsModule, ratesModule, itemModule, progressModule, itemsModule, activityModule, contributorsModule, classifiersModule, costModule, reposModule, accessModule, auditModule, aboutModule, pipelineModule, promptsModule, similarModule, accountsModule, mainCiModule, batchModule];
