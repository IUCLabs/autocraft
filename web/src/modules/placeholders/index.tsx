import { BadgeCheckIcon, CoinsIcon, FolderGit2Icon, ScaleIcon, ShieldIcon, type LucideIcon } from "lucide-react";
import type { FeatureModule, NavEntry, Permission, ViewProps } from "../../registry/types";

// Pages from docs/dashboard-spec.md that this design phase leaves for later.
// Each is a real module so the nav, permissions and routes already work.
function placeholder(id: string, label: string, icon: LucideIcon, group: NavEntry["group"], order: number, permission: Permission, blurb: string): FeatureModule {
  function View(_: ViewProps) {
    const Icon = icon;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1.5 p-8 text-center">
        <Icon className="mb-1 text-[28px] text-ink/25" />
        <p className="text-md font-semibold">{label}</p>
        <p className="max-w-[44ch] text-sm text-ink/60">{blurb}</p>
        <p className="text-xs text-ink/40">Designed in a later phase.</p>
      </div>
    );
  }
  return {
    id,
    permission,
    nav: { label, icon, to: `/${id}`, group, order },
    routes: [{ path: id, view: { id, title: label, panels: [{ id: "main", title: label, component: View, defaultSize: 100 }] } }],
  };
}

export const placeholderModules: FeatureModule[] = [
  placeholder("contributors", "Contributors", BadgeCheckIcon, "insight", 10, "viewer", "Whitelist tiers, merge rates and overrides per author."),
  placeholder("classifiers", "Classifiers", ScaleIcon, "insight", 11, "viewer", "Agreement between classifiers per field, with the disagreeing items."),
  placeholder("cost", "Run and cost", CoinsIcon, "insight", 12, "viewer", "Agent runs, tokens per stage and model, and items done per repo."),
  placeholder("repos", "Repos", FolderGit2Icon, "operator", 20, "operator", "Tracked repos: add, remove and sync."),
  placeholder("access", "Access", ShieldIcon, "operator", 21, "operator", "Access list, active sessions and the audit log."),
];
