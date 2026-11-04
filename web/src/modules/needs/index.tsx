import { HandWavingIcon } from "@phosphor-icons/react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import type { FeatureModule, RouteDef, ViewDef, ViewProps } from "../../registry/types";
import { Workspace } from "../../shell/Workspace";
import { Segmented } from "../../ui/molecules/Segmented";
import { decisionsModule } from "../decisions";
import { FeedbackTab } from "./FeedbackTab";
import { StoppedTab } from "./StoppedTab";
import { useSummary } from "./state";

type Tab = "decisions" | "feedback" | "stopped";
const TABS: Tab[] = ["decisions", "feedback", "stopped"];
const LABEL: Record<Tab, string> = { decisions: "Decisions", feedback: "Feedback", stopped: "Stopped" };

function useTab(): Tab {
  const { pathname } = useLocation();
  const [sp] = useSearchParams();
  const t = sp.get("tab");
  return !pathname.startsWith("/needs/decisions") && TABS.includes(t as Tab) ? (t as Tab) : "decisions";
}

function Tabs() {
  const tab = useTab();
  const navigate = useNavigate();
  const { data } = useSummary();
  const options = TABS.map((t) => ({ value: t, label: LABEL[t], count: data?.counts[t] }));
  return <Segmented label="Needs you" value={tab} options={options} onChange={(t) => navigate(t === "decisions" ? "/needs" : `/needs?tab=${t}`)} />;
}

const decisionsView = decisionsModule.routes[0]!.view;

function Body(props: ViewProps) {
  const tab = useTab();
  if (tab === "feedback") return <FeedbackTab />;
  if (tab === "stopped") return <StoppedTab />;
  return <Workspace view={decisionsView} props={props} />;
}

const view: ViewDef = {
  id: "needs",
  title: "Needs you",
  toolbar: Tabs,
  panels: [{ id: "body", title: "Needs you", component: Body, defaultSize: 100 }],
};

const route = (path: string): RouteDef => ({ path, view });

function useBadge() {
  const c = useSummary().data?.counts;
  return c ? c.decisions + c.feedback + c.stopped : undefined;
}

export const needsModule: FeatureModule = {
  id: "needs",
  permission: "viewer",
  nav: { label: "Needs you", icon: HandWavingIcon, to: "/needs", group: "work", order: 1, useBadge },
  routes: [route("needs"), route("needs/decisions/:id?"), route("needs/decisions/:repo/:n"), route("needs/decisions/:repo/:n/:kind")],
};
