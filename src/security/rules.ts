// Constants, types and the pure parsers of the security deep scan (src/security). No Node imports: the
// prompt registry (src/prompts) imports this file, and the web mockup imports that.
import type { FindingSeverity } from "../../web/src/api/types.ts";

/** The repo name under which the scan's agent runs and job are recorded. It is never a tracked repo, so every listing that leaves out the repos a viewer may not see also leaves out the scan's runs. */
export const SECURITY_REPO = "(security)";
export const SECURITY_STEP = "security-scan";

export const SEVERITIES: FindingSeverity[] = ["critical", "high", "medium", "low"];
/** A finding the area scan reports needs at least this confidence. */
export const MIN_CONFIDENCE = 0.8;
/** Verify keeps a finding only with at least this score (of 10) for "still a real vulnerability". */
export const MIN_VERIFY_SCORE = 8;
export const AREAS_MAX = 60;
export const AREA_PATHS_MAX = 40;
export const ENTRY_POINTS_MAX = 60;
export const FINDINGS_PER_AREA_MAX = 12;
export const REFS_MAX = 8;
export const TITLE_MAX = 160;
export const TEXT_MAX = 2000;
export const SUMMARY_MAX = 4000;
export const REASON_MAX = 500;
export const ENTRY_KINDS = ["file-open", "import", "font-image", "plugin-script", "network", "ipc-deeplink", "ci-workflow", "build-script", "other"] as const;

export type EntryPoint = { name: string; kind: string; where: string };
export type ThreatArea = { name: string; paths: string[]; entryPoints: string[]; risk: number; why: string };
export type ThreatModel = { summary: string; entryPoints: EntryPoint[]; areas: ThreatArea[] };
export type Candidate = { title: string; severity: FindingSeverity; urgent: boolean; category: string; refs: { path: string; line: number; claim: string }[]; reach: string; impact: string };
export type VerifyVerdict = { verdict: "confirmed" | "disproved"; score: number; result: string; notes: string; proposedTest: string | null };

/** What each security prompt is rendered from. `repo` and `number` carry the scan's pseudo repo and the scan id, so the agent run lists the scan, never a real item. */
type Base = { repo: typeof SECURITY_REPO; number: number; project: string; commit: string; repo_dir?: string };
export type SecurityModelInput = Base;
export type SecurityAreaInput = Base & { area: { name: string; paths: string[]; why: string }; entry_points: EntryPoint[]; summary: string };
export type SecurityVerifyInput = Base & { finding: Candidate & { area: string } };

const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

/** The JSON object in a reply: from the first "{" to the last "}". */
export function jsonObject(text: string): Record<string, unknown> | null {
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try {
    const v = JSON.parse(text.slice(a, b + 1)) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** A repository-relative path, or null: the sandbox's /repo prefix is dropped; absolute, parent and empty segments are refused. */
export function relPath(p: unknown): string | null {
  if (typeof p !== "string") return null;
  let s = p.trim().replace(/^\/repo\//, "").replace(/^\.\//, "").replace(/\/+$/, "");
  if (!s || s.length > 300 || s.startsWith("/") || s.includes("\0")) return null;
  if (s.split("/").some((c) => c === "" || c === "..")) return null;
  s = s.replace(/\\/g, "/");
  return s;
}

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** The threat model of a reply: entry points and areas in risk order (highest first, ties keep the reply's order). Null without at least one valid area. */
export function parseThreatModel(text: string): ThreatModel | null {
  const o = jsonObject(text);
  if (!o) return null;
  const entryPoints: EntryPoint[] = [];
  for (const e of list(o.entry_points).slice(0, ENTRY_POINTS_MAX)) {
    const x = e as Record<string, unknown>;
    const name = str(x?.name, 120);
    if (!name) continue;
    entryPoints.push({ name, kind: ENTRY_KINDS.includes(x.kind as never) ? String(x.kind) : "other", where: str(x.where, 200) ?? "" });
  }
  const areas: ThreatArea[] = [];
  const seen = new Set<string>();
  for (const a of list(o.areas)) {
    const x = a as Record<string, unknown>;
    const name = str(x?.name, 120);
    const paths = [...new Set(list(x?.paths).map(relPath).filter((p): p is string => p !== null))].slice(0, AREA_PATHS_MAX);
    if (!name || !paths.length || seen.has(name)) continue;
    seen.add(name);
    const risk = typeof x.risk === "number" && Number.isFinite(x.risk) ? Math.min(5, Math.max(1, Math.round(x.risk))) : 3;
    areas.push({ name, paths, entryPoints: list(x.entry_points).filter((n): n is string => typeof n === "string").slice(0, ENTRY_POINTS_MAX), risk, why: str(x.why, 400) ?? "" });
  }
  if (!areas.length) return null;
  const ordered = areas.map((a, i) => ({ a, i })).sort((p, q) => q.a.risk - p.a.risk || p.i - q.i).map((x) => x.a).slice(0, AREAS_MAX);
  return { summary: str(o.summary, SUMMARY_MAX) ?? "", entryPoints, areas: ordered };
}

/** The findings of an area reply. A finding is kept only with a title, a severity, confidence of at least MIN_CONFIDENCE, a reach and an impact, and at least one ref with a path and a line; refs without both are dropped. Null when the reply is not the expected object. */
export function parseCandidates(text: string): Candidate[] | null {
  const o = jsonObject(text);
  if (!o || !Array.isArray(o.findings)) return null;
  const out: Candidate[] = [];
  for (const f of o.findings.slice(0, FINDINGS_PER_AREA_MAX)) {
    const x = f as Record<string, unknown>;
    const title = str(x?.title, TITLE_MAX), reach = str(x?.reach, TEXT_MAX), impact = str(x?.impact, TEXT_MAX);
    const severity = SEVERITIES.find((s) => s === x?.severity);
    const confidence = typeof x?.confidence === "number" ? x.confidence : 0;
    if (!title || !reach || !impact || !severity || confidence < MIN_CONFIDENCE) continue;
    const refs: Candidate["refs"] = [];
    for (const r of list(x.refs).slice(0, REFS_MAX)) {
      const y = r as Record<string, unknown>;
      const path = relPath(y?.path), line = y?.line;
      if (path && typeof line === "number" && Number.isInteger(line) && line >= 1) refs.push({ path, line, claim: str(y.claim, 400) ?? "" });
    }
    if (!refs.length) continue;
    out.push({ title, severity, urgent: x.urgent === true, category: str(x.category, 60) ?? "other", refs, reach, impact });
  }
  return out;
}

/** The verdict of a verify reply, or null when it is not one. */
export function parseVerdict(text: string): VerifyVerdict | null {
  const o = jsonObject(text);
  if (!o || (o.verdict !== "confirmed" && o.verdict !== "disproved")) return null;
  const score = typeof o.score === "number" && Number.isFinite(o.score) ? Math.min(10, Math.max(1, Math.round(o.score))) : null;
  const result = str(o.result, TEXT_MAX);
  if (score === null || !result) return null;
  return { verdict: o.verdict, score, result, notes: str(o.notes, TEXT_MAX) ?? "", proposedTest: str(o.proposed_test, TEXT_MAX) };
}

/** A finding survives verification when the verdict confirms it and the score is high enough. */
export const survives = (v: VerifyVerdict): boolean => v.verdict === "confirmed" && v.score >= MIN_VERIFY_SCORE;

/** Normalised title for matching the same finding reported twice: lower case words only. */
export const titleKey = (t: string): string => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
