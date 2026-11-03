// Every write the app made on GitHub, read from the audit table. Anyone signed in may read it: it shows what
// is public on GitHub anyway. Rows of repos the viewer may not see are left out.
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { GithubActivityPage, GithubActivityRow } from "../../../web/src/api/types.ts";
import { ORG } from "../../act/templates.ts";
import { GITHUB_ACTIONS } from "../../github/actions.ts";
import { HttpError } from "../server/util.ts";
import type { Req } from "../types.ts";
import { itemState } from "./shown.ts";
import { visibleRepos } from "./visible.ts";
import { canSeeInternals } from "./staff.ts";

const PAGE = 50;
const ACTIONS = Object.keys(GITHUB_ACTIONS);
const like = (s: string): string => s.replace(/[\\%_]/g, "\\$&");

type Raw = { rowid: number; at: string; login: string; action: string; target: string | null; details: string | null };

/** `repo#n` is an item, `repo:branch` a branch, a bare name a repo. */
function parseTarget(t: string | null): { repo: string; number: number | null; branch: string | null } {
  const m = /^([^#:]+)#(\d+)$/.exec(t ?? "");
  if (m) return { repo: m[1]!, number: Number(m[2]), branch: null };
  const b = /^([^#:]+):(.+)$/.exec(t ?? "");
  if (b) return { repo: b[1]!, number: null, branch: b[2]! };
  return { repo: t ?? "", number: null, branch: null };
}

const short = (s: unknown): string => String(s ?? "").slice(0, 7);
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s).replace(/\s+/g, " ");

function detailOf(action: string, d: Record<string, unknown>): string {
  const list = Array.isArray(d.labels) ? (d.labels as unknown[]).join(", ") : "";
  switch (action) {
    case "labels-apply": return list;
    case "label-create": return String(d.name ?? "");
    case "act-comment": case "fixup-comment": case "fixup-comment-edit": case "fixissue-comment": return clip(String(d.text ?? ""), 160);
    case "batch-pr-close": return clip(String(d.text ?? ""), 160);
    case "merge": return [d.method, d.commit ? short(d.commit) : "", d.batch ? `in ${d.batch}` : ""].filter(Boolean).join(" ");
    case "assign": case "unassign": return String(d.assignee ?? "");
    case "review-post": case "review-edit": return d.head ? `at ${short(d.head)}` : "";
    case "fixup-push": case "batch-push": case "fixissue-push": return [d.branch, d.commit ? `@ ${short(d.commit)}` : ""].filter(Boolean).join(" ");
    case "batch-pr": case "fixissue-pr": return String(d.branch ?? d.batch ?? "");
    case "fork-create": return "";
    default: return "";
  }
}

function urlOf(r: { action: string; repo: string; number: number | null; branch: string | null; kind: string | undefined }, d: Record<string, unknown>): string {
  if (typeof d.url === "string" && d.url.startsWith("https://github.com/")) return d.url;
  const base = r.repo.includes("/") ? `https://github.com/${r.repo}` : `https://github.com/${ORG}/${r.repo}`;
  if (r.action.endsWith("-push")) {
    const remote = typeof d.remote === "string" ? d.remote : r.repo.includes("/") ? r.repo : `${ORG}/${r.repo}`;
    return d.commit ? `https://github.com/${remote}/commit/${String(d.commit)}` : `https://github.com/${remote}/tree/${String(d.branch ?? "")}`;
  }
  if (r.action === "merge" && typeof d.commit === "string") return `${base}/commit/${d.commit}`;
  if (r.action === "label-create") return `${base}/labels`;
  if (r.number !== null) return `${base}/${r.kind === "pr" ? "pull" : "issues"}/${r.number}`;
  if (r.action === "fork-create") return base;
  return r.branch ? `${base}/tree/${r.branch}` : base;
}

export async function githubActivity(db: DatabaseSync, req: Req): Promise<GithubActivityPage> {
  const q = req.query;
  const repo = (q.get("repo") ?? "").trim();
  const action = q.get("action") ?? "";
  const from = q.get("from") ?? "";
  const to = q.get("to") ?? "";
  const numberRaw = q.get("number");
  const number = numberRaw ? Number(numberRaw) : null;
  const afterRaw = q.get("after");
  const after = afterRaw ? Number(afterRaw) : null;
  const limit = Math.min(Math.max(Number(q.get("limit")) || PAGE, 1), 200);
  if (action && !ACTIONS.includes(action)) throw new HttpError(400, "unknown action");
  if (number !== null && !(Number.isInteger(number) && number > 0)) throw new HttpError(400, "number must be a positive whole number");
  if (after !== null && !Number.isInteger(after)) throw new HttpError(400, "after must be a row id");
  for (const [k, v] of [["from", from], ["to", to]] as const) if (v && Number.isNaN(Date.parse(v))) throw new HttpError(400, `${k} must be a date`);
  if (repo && !(await visibleRepos(db, req)).includes(repo)) throw new HttpError(404, `${repo} is not a tracked repo`);

  const where: string[] = [`action IN (${ACTIONS.map(() => "?").join(", ")})`];
  const args: SQLInputValue[] = [...ACTIONS];
  if (action) { where.push("action = ?"); args.push(action); }
  if (repo) { where.push("(target = ? OR target LIKE ? ESCAPE '\\' OR target LIKE ? ESCAPE '\\')"); args.push(repo, `${like(repo)}#%`, `${like(repo)}:%`); }
  if (number !== null) { where.push(repo ? "target = ?" : "target LIKE ? ESCAPE '\\'"); args.push(repo ? `${repo}#${number}` : `%#${number}`); }
  if (from) { where.push("at >= ?"); args.push(new Date(from).toISOString()); }
  if (to) { where.push("at <= ?"); args.push(new Date(/^\d{4}-\d{2}-\d{2}$/.test(to) ? `${to}T23:59:59.999Z` : to).toISOString()); }
  // Allow-list: a viewer sees only rows of repos visible to them; operators and maintainers see every row, untracked repos included.
  if (!canSeeInternals(req)) {
    const visible = await visibleRepos(db, req);
    where.push(`min(instr(target || '#', '#'), instr(target || ':', ':')) > 1 AND substr(target, 1, min(instr(target || '#', '#'), instr(target || ':', ':')) - 1) IN (${visible.map(() => "?").join(", ") || "NULL"})`);
    args.push(...visible);
  }
  const w = where.join(" AND ");
  const total = Number((db.prepare(`SELECT COUNT(*) AS n FROM audit WHERE ${w}`).get(...args) as { n: number }).n);
  const rows = db.prepare(`SELECT rowid, at, login, action, target, details FROM audit WHERE ${w}${after !== null ? " AND rowid < ?" : ""} ORDER BY rowid DESC LIMIT ?`)
    .all(...args, ...(after !== null ? [after] : []), limit + 1) as Raw[];
  const more = rows.length > limit;
  const page = rows.slice(0, limit);

  const item = db.prepare("SELECT title, kind, state FROM main.items WHERE repo = ? AND number = ?");
  const out: GithubActivityRow[] = page.map((r) => {
    let d: Record<string, unknown> = {};
    try {
      const j = JSON.parse(r.details ?? "null") as unknown;
      if (j && typeof j === "object" && !Array.isArray(j)) d = j as Record<string, unknown>;
    } catch { /* not JSON: shown without details */ }
    const t = parseTarget(r.target);
    const it = t.number !== null ? item.get(t.repo, t.number) as { title: string | null; kind: string; state: string } | undefined : undefined;
    const source = typeof d.decision === "string" ? `decision ${d.decision}` : typeof d.run === "string" ? `${r.login} ${d.run}` : r.login;
    return {
      id: String(r.rowid), at: r.at, action: r.action, label: GITHUB_ACTIONS[r.action]!, repo: t.repo, number: t.number, branch: t.branch,
      title: it?.title ?? null, kind: it ? (it.kind === "pr" ? "pr" : "issue") : null, state: it ? itemState(it.state) : null, detail: detailOf(r.action, d), url: urlOf({ action: r.action, ...t, kind: it?.kind }, d), source,
      error: typeof d.error === "string" ? d.error : null,
      outcome: d.state === "started" ? "unknown" : d.error !== undefined ? "failed" : "done",
    };
  });
  return { rows: out, total, next: more ? out[out.length - 1]!.id : null, actions: ACTIONS.map((a) => ({ action: a, label: GITHUB_ACTIONS[a]! })) };
}
