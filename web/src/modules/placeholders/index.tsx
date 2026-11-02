import { CoinsIcon, ScaleIcon, type LucideIcon } from "lucide-react";
import type { FeatureModule, NavEntry, Permission, ViewProps } from "../../registry/types";

// Pages from docs/dashboard-spec.md that the app doesn't have yet. The server
// still renders them, so the nav links there with a full page load; the
// mockup, which has no server, shows a placeholder instead.
const MOCK = import.meta.env.VITE_MOCK === "1";

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
  if (!MOCK) return { id, permission, nav: { label, icon, to: `/${id}`, group, order, page: true }, routes: [] };
  return {
    id,
    permission,
    nav: { label, icon, to: `/${id}`, group, order },
    routes: [{ path: id, view: { id, title: label, panels: [{ id: "main", title: label, component: View, defaultSize: 100 }] } }],
  };
}

export const placeholderModules: FeatureModule[] = [
  placeholder("classifiers", "Classifiers", ScaleIcon, "insight", 11, "viewer", "Agreement between classifiers per field, with the disagreeing items."),
  placeholder("cost", "Run and cost", CoinsIcon, "insight", 12, "viewer", "Agent runs, tokens per stage and model, and items done per repo."),
];
