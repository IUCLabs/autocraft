// Readable URLs for decisions and items, and the rules that turn a decision route back into a lookup.
// No framework imports: the server shares `pickDecision` and the tests load this file directly.
import type { Decision } from "../api/types.ts";

const KIND_ORDER = ["scope", "duplicate", "close", "merge", "split", "other"];

/** `/items/<repo>/<n>`; the repo is the short name the dashboard shows. */
export const itemPath = (repo: string, number: number): string => `/items/${encodeURIComponent(shortRepo(repo))}/${number}`;

/** `storytold/designcraft` and `designcraft` name the same repo. */
export const shortRepo = (repo: string): string => repo.slice(repo.lastIndexOf("/") + 1);

type DecisionRef = Pick<Decision, "id" | "repo" | "number">;

/**
 * `/decisions/<repo>/<n>` for a decision about one item, `/decisions/<encoded id>` for a batch.
 * The readable form opens the item's first open decision, so a decision that shares its item
 * with another (`sharesItem`) keeps the id form.
 */
export function decisionPath(d: DecisionRef | undefined, opts: { search?: string; sharesItem?: boolean } = {}): string {
  const tail = opts.search ? `?${opts.search}` : "";
  if (!d) return `/decisions${tail}`;
  if (d.number == null || opts.sharesItem) return `/decisions/${encodeURIComponent(d.id)}${tail}`;
  return `/decisions/${encodeURIComponent(shortRepo(d.repo))}/${d.number}${tail}`;
}

export type DecisionRoute = { by: "id"; id: string } | { by: "item"; repo: string; number: number } | { by: "none" };

/** What a `decisions/:id?` or `decisions/:repo/:n` route asks for. */
export function parseDecisionRoute(p: { id?: string; repo?: string; n?: string }): DecisionRoute {
  if (p.repo !== undefined && p.n !== undefined) {
    const number = Number(p.n);
    return Number.isInteger(number) && number > 0 ? { by: "item", repo: shortRepo(decodeURIComponent(p.repo)), number } : { by: "none" };
  }
  return p.id ? { by: "id", id: decodeURIComponent(p.id) } : { by: "none" };
}

/** The decision a readable link opens: the first open one in inbox order (kind, then oldest), else the most recently asked. */
export function pickDecision<T extends Pick<Decision, "kind" | "answer" | "askedAt">>(ds: T[]): T | undefined {
  const open = ds.filter((d) => !d.answer).sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.askedAt.localeCompare(b.askedAt));
  return open[0] ?? [...ds].sort((a, b) => b.askedAt.localeCompare(a.askedAt))[0];
}
