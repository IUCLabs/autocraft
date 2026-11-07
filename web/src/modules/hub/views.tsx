// Reports and Settings: one list each of the pages that moved out of the main navigation. A page the reader's role cannot open is left out.
import { Link } from "react-router-dom";
import { ArrowRightIcon, BookOpenIcon, BrainIcon, ChartLineUpIcon, ClockCounterClockwiseIcon, CoinsIcon, DiscordLogoIcon, FileTextIcon, GaugeIcon, GithubLogoIcon, HeartbeatIcon, KeyIcon, PlugsConnectedIcon, RobotIcon, ScalesIcon, TreeStructureIcon, UsersIcon, FolderSimpleIcon, StackIcon, type Icon } from "@phosphor-icons/react";
import { Page } from "../../ui/organisms/Page";
import { modules } from "../../registry";
import { can } from "../../registry/permissions";
import { useUser } from "../../shell/UserContext";

interface Entry { label: string; to: string; icon: Icon; path: string }

const REPORTS: Entry[] = [
  { label: "Progress", to: "/progress", path: "progress", icon: ChartLineUpIcon },
  { label: "Activity", to: "/activity", path: "activity", icon: ClockCounterClockwiseIcon },
  { label: "Cost", to: "/cost", path: "cost", icon: CoinsIcon },
  { label: "Rates", to: "/rates", path: "rates", icon: GaugeIcon },
  { label: "Model calls", to: "/agents", path: "agents", icon: RobotIcon },
  { label: "Classifiers", to: "/classifiers", path: "classifiers", icon: ScalesIcon },
  { label: "Main CI", to: "/main-ci", path: "main-ci", icon: HeartbeatIcon },
];

const SETTINGS: Entry[] = [
  { label: "Pipeline", to: "/pipeline", path: "pipeline", icon: TreeStructureIcon },
  { label: "Repos", to: "/repos", path: "repos", icon: FolderSimpleIcon },
  { label: "Contributors", to: "/contributors", path: "contributors", icon: UsersIcon },
  { label: "Build environments", to: "/envs", path: "envs", icon: StackIcon },
  { label: "Accounts", to: "/accounts", path: "accounts", icon: BrainIcon },
  { label: "Access", to: "/access", path: "access", icon: KeyIcon },
  { label: "GitHub App", to: "/admin/github-app", path: "admin/github-app", icon: GithubLogoIcon },
  { label: "Discord", to: "/admin/discord", path: "admin/discord", icon: DiscordLogoIcon },
  { label: "Prompts", to: "/prompts", path: "prompts", icon: FileTextIcon },
  { label: "Audit log", to: "/audit", path: "audit", icon: BookOpenIcon },
  { label: "Connect an agent", to: "/connect", path: "connect", icon: PlugsConnectedIcon },
];

function Links({ entries }: { entries: Entry[] }) {
  const user = useUser();
  const open = entries.filter((e) => modules.some((m) => can(user, m.permission) && m.routes.some((r) => (r.path === e.path || r.path.startsWith(`${e.path}/`)) && (!r.permission || can(user, r.permission)))));
  return (
    <ul className="mt-4 grid gap-px overflow-hidden rounded-md border border-line bg-line sm:grid-cols-2">
      {open.map((e) => (
        <li key={e.to} className="bg-panel">
          <Link to={e.to} className="flex h-12 items-center gap-3 px-4 text-sm hover:bg-ink/[0.04] max-md:h-14">
            <e.icon className="text-[17px] text-ink/55" />
            <span className="flex-1 font-medium">{e.label}</span>
            <ArrowRightIcon className="text-ink/35" />
          </Link>
        </li>
      ))}
    </ul>
  );
}

export const ReportsView = () => (
  <Page title="Reports">
    <Links entries={REPORTS} />
  </Page>
);

export const SettingsView = () => (
  <Page title="Settings">
    <Links entries={SETTINGS} />
  </Page>
);

