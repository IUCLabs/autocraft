// Owner directions over JSON. Everyone who may see the repo reads its directions; operators add, edit and retire them and decide the
// drafts proposed from their notes (src/directions-propose.ts). Every write is audited.
import type { DatabaseSync } from "node:sqlite";
import type { ItemState } from "../../../web/src/api/types.ts";
import type { DecisionDirectionProposals, DirectionAddBody, DirectionProposal, DirectionView, RepoDirections } from "../../../web/src/api/types.ts";
import { ALL_REPOS, DirectionError, addDirection, directionsOfRepo, editDirection, retireDirection, type DirectionRow } from "../../directions.ts";
import { ProposalError, acceptProposal, dismissProposal, openProposals, type ProposalRow } from "../../directions-propose.ts";
import { audit } from "../audit.ts";
import { HttpError } from "../server/util.ts";
import type { Req } from "../types.ts";
import { needVisible } from "./visible.ts";

const wrap = <T>(f: () => T): T => {
  try {
    return f();
  } catch (e) {
    if (e instanceof DirectionError || e instanceof ProposalError) throw new HttpError(400, e.message);
    throw e;
  }
};

const body = (req: Req): Record<string, unknown> => {
  if (!req.json || typeof req.json !== "object" || Array.isArray(req.json)) throw new HttpError(400, "the body must be a JSON object");
  return req.json as Record<string, unknown>;
};
const text = (v: unknown, what: string): string => {
  if (typeof v !== "string" || !v.trim()) throw new HttpError(400, `${what} must be text`);
  return v;
};
const operatorOf = (req: Req): string => {
  if (req.user.role !== "operator") throw new HttpError(403, "only operators change directions");
  return req.user.login;
};

/** The item the source decision is about, when both are known. */
function sourceItemOf(db: DatabaseSync, decisionId: string | null): DirectionView["sourceItem"] {
  if (!decisionId) return null;
  const r = db.prepare(`SELECT i.repo, i.number, i.kind, i.state, i.title FROM decisions d JOIN items i ON i.repo = d.repo AND i.number = d.number WHERE d.id = ?`).get(decisionId) as
    { repo: string; number: number; kind: "pr" | "issue"; state: string; title: string } | undefined;
  return r ? { repo: r.repo, number: r.number, kind: r.kind, state: r.state.toLowerCase() as ItemState, title: r.title } : null;
}
const viewOf = (db: DatabaseSync, d: DirectionRow): DirectionView => ({
  id: d.id, repo: d.repo, text: d.text, createdBy: d.created_by, createdAt: d.created_at, sourceDecision: d.source_decision, sourceItem: sourceItemOf(db, d.source_decision), retiredAt: d.retired_at,
});
const proposalOf = (p: ProposalRow): DirectionProposal => ({
  id: p.id, repo: p.repo, number: p.number, decisionId: p.decision_id, note: p.note, draft: p.draft ?? "", createdAt: p.created_at,
});

export function repoDirections(db: DatabaseSync, repo: string, operator: boolean): RepoDirections {
  const { active, retired } = directionsOfRepo(db, repo);
  return { repo, directions: active.map((d) => viewOf(db, d)), retired: retired.map((d) => viewOf(db, d)), proposals: operator ? openProposals(db, { repo }).map(proposalOf) : [] };
}

export async function get(db: DatabaseSync, req: Req): Promise<RepoDirections> {
  const repo = req.params.repo!;
  await needVisible(db, req, repo);
  return repoDirections(db, repo, req.user.role === "operator");
}

export async function add(db: DatabaseSync, req: Req): Promise<RepoDirections> {
  const by = operatorOf(req), repo = req.params.repo!;
  await needVisible(db, req, repo);
  const b = body(req) as Partial<DirectionAddBody>;
  const scope = b.allRepos === true ? ALL_REPOS : repo;
  const id = wrap(() => addDirection(db, scope, text(b.text, "text"), by));
  audit(db, by, "direction-add", `${scope} #${id}`);
  return repoDirections(db, repo, true);
}

/** The repo of the direction for the audit target and the reply: '*' directions answer for the repo page that asked. */
function find(db: DatabaseSync, req: Req): { id: number; repo: string } {
  const id = Number(req.params.id);
  const row = db.prepare("SELECT repo FROM repo_directions WHERE id = ?").get(id) as { repo: string } | undefined;
  if (!row) throw new HttpError(404, "no such direction");
  return { id, repo: row.repo };
}

export async function edit(db: DatabaseSync, req: Req): Promise<{ ok: true }> {
  const by = operatorOf(req), { id, repo } = find(db, req);
  if (repo !== ALL_REPOS) await needVisible(db, req, repo);
  wrap(() => editDirection(db, id, text(body(req).text, "text")));
  audit(db, by, "direction-edit", `${repo} #${id}`);
  return { ok: true };
}

export async function retire(db: DatabaseSync, req: Req): Promise<{ ok: true }> {
  const by = operatorOf(req), { id, repo } = find(db, req);
  if (repo !== ALL_REPOS) await needVisible(db, req, repo);
  if (!retireDirection(db, id)) throw new HttpError(409, "the direction is retired already");
  audit(db, by, "direction-retire", `${repo} #${id}`);
  return { ok: true };
}

function proposalRepo(db: DatabaseSync, req: Req): { id: number; repo: string } {
  const id = Number(req.params.id);
  const row = db.prepare("SELECT repo FROM direction_proposals WHERE id = ?").get(id) as { repo: string } | undefined;
  if (!row) throw new HttpError(404, "no such proposal");
  return { id, repo: row.repo };
}

export async function acceptProposalApi(db: DatabaseSync, req: Req): Promise<{ directionId: number }> {
  const by = operatorOf(req), { id, repo } = proposalRepo(db, req);
  await needVisible(db, req, repo);
  const b = req.json && typeof req.json === "object" && !Array.isArray(req.json) ? (req.json as Record<string, unknown>) : {};
  const dir = wrap(() => acceptProposal(db, id, by, typeof b.text === "string" ? b.text : undefined, b.allRepos === true ? ALL_REPOS : undefined));
  audit(db, by, "direction-accept", `${repo} proposal ${id} -> #${dir}`);
  return { directionId: dir };
}

export async function dismissProposalApi(db: DatabaseSync, req: Req): Promise<{ ok: true }> {
  const by = operatorOf(req), { id, repo } = proposalRepo(db, req);
  await needVisible(db, req, repo);
  wrap(() => dismissProposal(db, id, by));
  audit(db, by, "direction-dismiss", `${repo} proposal ${id}`);
  return { ok: true };
}

/** The open proposals drafted from the note of one decision; operators only. */
export async function forDecision(db: DatabaseSync, req: Req): Promise<DecisionDirectionProposals> {
  if (req.user.role !== "operator") return { proposals: [] };
  const id = req.params.id!;
  const repo = (db.prepare("SELECT repo FROM decisions WHERE id = ?").get(id) as { repo: string | null } | undefined)?.repo;
  if (repo) await needVisible(db, req, repo);
  return { proposals: openProposals(db, { decisionId: id }).map(proposalOf) };
}
