// Operator switches for the build features. Stored in settings as `build_feature:<f>` and, for repo-scoped
// features, `build_feature:<f>:<repo>`; a missing row means off.
import type { DatabaseSync } from "node:sqlite";
import { audit } from "../dash/audit.ts";

export const BUILD_FEATURES = ["screenshots", "push-tests", "batch-build", "scan-tests", "nightly", "pr-builds"] as const;
export type BuildFeature = (typeof BUILD_FEATURES)[number];

/** Repo-scoped features need the global switch and the repo's own switch. */
export const REPO_SCOPED: Record<BuildFeature, boolean> = {
  screenshots: true, "push-tests": true, "batch-build": true, "scan-tests": false, nightly: true, "pr-builds": true,
};

export const isFeature = (s: unknown): s is BuildFeature => typeof s === "string" && (BUILD_FEATURES as readonly string[]).includes(s);

const keyOf = (f: BuildFeature, repo?: string): string => (repo ? `build_feature:${f}:${repo}` : `build_feature:${f}`);

const read = (db: DatabaseSync, key: string): boolean =>
  (db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined)?.value === "on";

/** Without `repo` a repo-scoped feature reports its global switch; callers that loop repos must pass the repo. */
export function featureOn(db: DatabaseSync, f: BuildFeature, repo?: string): boolean {
  if (!read(db, keyOf(f))) return false;
  if (!REPO_SCOPED[f] || repo === undefined) return true;
  return read(db, keyOf(f, repo));
}

export function setFeature(db: DatabaseSync, f: BuildFeature, on: boolean, by: string, repo?: string): void {
  const scoped = REPO_SCOPED[f] ? repo : undefined;
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(keyOf(f, scoped), on ? "on" : "off");
  audit(db, by, "build-feature", f, { feature: f, on, repo: scoped ?? null });
}

export function featureStates(db: DatabaseSync): { feature: BuildFeature; on: boolean; repos: string[] }[] {
  return BUILD_FEATURES.map((feature) => {
    const repos = REPO_SCOPED[feature]
      ? (db.prepare("SELECT key FROM settings WHERE key LIKE ? ESCAPE '\\' AND value = 'on'").all(`build\\_feature:${feature}:%`) as { key: string }[])
        .map((r) => r.key.slice(`build_feature:${feature}:`.length)).sort()
      : [];
    return { feature, on: read(db, keyOf(feature)), repos };
  });
}
