// Owner directions (table repo_directions): standing instructions for a repo that the reviews check every PR against.
import type { DatabaseSync } from "node:sqlite";
import { connect } from "./db.ts";
import type { Direction } from "./review/opus-parse.ts";

export const ALL_REPOS = "*";

export type DirectionRow = Direction & { repo: string; created_by: string; created_at: string; source_decision: string | null; retired_at: string | null };

/** The active directions of a repo: its own and those for every repo, oldest first. */
export function activeDirections(db: DatabaseSync, repo: string): Direction[] {
  return db.prepare("SELECT id, text FROM repo_directions WHERE retired_at IS NULL AND repo IN (?, ?) ORDER BY id").all(repo, ALL_REPOS) as Direction[];
}

export function listDirections(db: DatabaseSync, repo?: string, withRetired = false): DirectionRow[] {
  return db.prepare(`SELECT * FROM repo_directions WHERE (? IS NULL OR repo IN (?, ?)) AND (? OR retired_at IS NULL) ORDER BY id`)
    .all(repo ?? null, repo ?? null, ALL_REPOS, withRetired ? 1 : 0) as DirectionRow[];
}

export function addDirection(db: DatabaseSync, repo: string, text: string, by: string, sourceDecision: string | null = null): number {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) throw new Error("a direction needs text");
  const r = db.prepare("INSERT INTO repo_directions (repo, text, created_by, created_at, source_decision) VALUES (?, ?, ?, ?, ?)").run(repo, t, by, new Date().toISOString(), sourceDecision);
  return Number(r.lastInsertRowid);
}

export class DirectionError extends Error {}

/** Replaces the text of an active direction. */
export function editDirection(db: DatabaseSync, id: number, text: string): void {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) throw new DirectionError("a direction needs text");
  if (!db.prepare("UPDATE repo_directions SET text = ? WHERE id = ? AND retired_at IS NULL").run(t, id).changes) throw new DirectionError("no active direction with that id");
}

/** The directions of a repo page: the repo's own and those for every repo, active ones first (oldest first), then retired ones (newest first). */
export function directionsOfRepo(db: DatabaseSync, repo: string): { active: DirectionRow[]; retired: DirectionRow[] } {
  const rows = db.prepare("SELECT * FROM repo_directions WHERE repo IN (?, ?) ORDER BY id").all(repo, ALL_REPOS) as DirectionRow[];
  return { active: rows.filter((d) => !d.retired_at), retired: rows.filter((d) => d.retired_at).reverse() };
}

/** False when the direction does not exist or is retired already. */
export function retireDirection(db: DatabaseSync, id: number): boolean {
  return db.prepare("UPDATE repo_directions SET retired_at = ? WHERE id = ? AND retired_at IS NULL").run(new Date().toISOString(), id).changes > 0;
}

const USAGE = "usage: autocraft directions list [--repo R] | add --repo R|--all TEXT | retire ID";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export const commands = {
  directions: {
    summary: "owner directions for reviews: list [--repo R] | add --repo R|--all TEXT | retire ID",
    run: (args: string[]) => {
      const [sub, ...rest] = args;
      const fail = (m: string): never => { console.error(m); process.exit(1); };
      const db = connect();
      if (sub === "list") {
        const repo = flag(rest, "--repo");
        for (const d of listDirections(db, repo, rest.includes("--all-states"))) console.log(`${d.id}\t${d.repo}\t${d.text}${d.retired_at ? `\t(retired ${d.retired_at})` : ""}`);
      } else if (sub === "add") {
        const repo = rest.includes("--all") ? ALL_REPOS : flag(rest, "--repo");
        if (!repo) fail(USAGE);
        const skip = new Set<number>();
        rest.forEach((a, i) => { if (a === "--repo") { skip.add(i); skip.add(i + 1); } if (a === "--all") skip.add(i); });
        const text = rest.filter((_, i) => !skip.has(i)).join(" ");
        if (!text.trim()) fail(USAGE);
        console.log(`direction ${addDirection(db, repo!, text, "operator")} added for ${repo === ALL_REPOS ? "every repo" : repo}`);
      } else if (sub === "retire") {
        const id = Number(rest[0]);
        if (!Number.isInteger(id)) fail(USAGE);
        if (!retireDirection(db, id)) fail(`no active direction ${id}`);
        console.log(`direction ${id} retired`);
      } else fail(USAGE);
    },
  },
};
