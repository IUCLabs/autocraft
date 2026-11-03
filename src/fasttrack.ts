// Fast track: operators mark items (PRs or issues) that go first in every stage ordering work by the work rank
// (Decide, Review, Fix, Fix-up, Verify, merges), in the order they were added; new ones join the end.
// A fast-tracked item runs through every stage even when its repo's Pipeline switch is off (src/pilot.ts); the global
// pipeline switch, approvals, daily limits and merge gates apply as before. A row of an item that is closed or merged
// stays in the table but is ignored: lists and positions count open items only.
//
//   craft-auto fasttrack add <url|repo#n> | remove <url|repo#n> | list
import type { DatabaseSync } from "node:sqlite";
import { ORG } from "./act/templates.ts";
import { audit } from "./dash/audit.ts";
import { connect } from "./db.ts";
import { isTracked } from "./repos.ts";

export class FastTrackError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export type FastRef = { repo: string; number: number };
export type FastItem = FastRef & { position: number; of: number; addedBy: string; addedAt: string };

const refText = (r: FastRef): string => `${r.repo}#${r.number}`;

/** `https://github.com/<owner>/<repo>/pull/<n>` (or `/issues/<n>`), `<repo>#<n>` or `<owner>/<repo>#<n>`. */
export function parseItemRef(input: unknown): FastRef {
  const t = typeof input === "string" ? input.trim() : "";
  const m = /^https?:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/(?:pull|issues)\/([1-9][0-9]*)(?:[/?#].*)?$/.exec(t)
    ?? /^(?:([A-Za-z0-9._-]+)\/)?([A-Za-z0-9._-]+)#([1-9][0-9]*)$/.exec(t);
  if (!m) throw new FastTrackError("not an item: use a GitHub URL, repo#number or owner/repo#number");
  if (m[1] && m[1].toLowerCase() !== ORG) throw new FastTrackError(`${m[1]}/${m[2]} is not in the ${ORG} organisation`);
  return { repo: m[2]!, number: Number(m[3]) };
}

/** Open fast-tracked items, first to run first. */
export function fastTrackList(db: DatabaseSync): FastItem[] {
  const rows = db.prepare(`SELECT f.repo, f.number, f.added_by, f.added_at FROM main.fast_track f
    JOIN main.items i ON i.repo = f.repo AND i.number = f.number AND i.state = 'OPEN' ORDER BY f.id`).all() as { repo: string; number: number; added_by: string; added_at: string }[];
  return rows.map((r, k) => ({ repo: r.repo, number: r.number, position: k + 1, of: rows.length, addedBy: r.added_by, addedAt: r.added_at }));
}

/** `repo#number` → position and list size, for the open fast-tracked items. */
export function fastPositions(db: DatabaseSync): Map<string, { position: number; of: number }> {
  return new Map(fastTrackList(db).map((f) => [refText(f), { position: f.position, of: f.of }]));
}

/** Adds an open item of a tracked repo to the end of the list. Returns false when it was already there. */
export function addFastTrack(db: DatabaseSync, by: string, input: unknown): { ref: FastRef; added: boolean } {
  const ref = parseItemRef(input);
  if (!isTracked(db, ref.repo)) throw new FastTrackError(`${ref.repo} is not a tracked repo`, 404);
  const item = db.prepare("SELECT state FROM main.items WHERE repo = ? AND number = ?").get(ref.repo, ref.number) as { state: string } | undefined;
  if (!item) throw new FastTrackError(`no item ${refText(ref)} in the mirror`, 404);
  if (item.state !== "OPEN") throw new FastTrackError(`${refText(ref)} is not open`, 409);
  const r = db.prepare("INSERT OR IGNORE INTO main.fast_track (repo, number, added_by, added_at) VALUES (?, ?, ?, ?)").run(ref.repo, ref.number, by, new Date().toISOString());
  if (r.changes) audit(db, by, "fasttrack-add", refText(ref));
  return { ref, added: r.changes > 0 };
}

/** Takes an item off the list; it returns to normal ranking. Returns false when it was not on it. */
export function removeFastTrack(db: DatabaseSync, by: string, input: unknown): { ref: FastRef; removed: boolean } {
  const ref = parseItemRef(input);
  const r = db.prepare("DELETE FROM main.fast_track WHERE repo = ? AND number = ?").run(ref.repo, ref.number);
  if (r.changes) audit(db, by, "fasttrack-remove", refText(ref));
  return { ref, removed: r.changes > 0 };
}

const FAST_BASE = 1e15;
/** Scores at or above this belong to fast-tracked items. */
export const FAST_FLOOR = FAST_BASE / 2;

/**
 * SQL for the score a stage orders by: a fast-tracked item outranks every ranked one, earlier additions first;
 * the others keep `scoreExpr`. `repo` and `number` are SQL expressions of the item.
 */
export const fastScoreSql = (repo: string, number: string, scoreExpr: string): string =>
  `COALESCE(${FAST_BASE} - (SELECT fq.id FROM main.fast_track fq WHERE fq.repo = ${repo} AND fq.number = ${number}), ${scoreExpr})`;


/** Work score of every ranked open item of the repo, with fast-tracked items raised above all others. */
export function workScores(db: DatabaseSync, repo: string): Map<number, number> {
  const out = new Map((db.prepare("SELECT number, score FROM main.item_rank WHERE repo = ?").all(repo) as { number: number; score: number }[]).map((r) => [r.number, r.score]));
  for (const f of db.prepare("SELECT number, id FROM main.fast_track WHERE repo = ?").all(repo) as { number: number; id: number }[]) out.set(f.number, FAST_BASE - f.id);
  return out;
}

export const commands = {
  fasttrack: {
    summary: "fasttrack add|remove <url|repo#n> | list: items that go first in every stage, in the order added",
    run(args: string[]): void {
      const db = connect();
      const [sub, item] = args;
      try {
        if (sub === "list" && args.length === 1) {
          const list = fastTrackList(db);
          if (!list.length) console.log("no fast-tracked items");
          for (const f of list) console.log(`${f.position} of ${f.of}  ${refText(f)}  added by ${f.addedBy} ${f.addedAt}`);
          return;
        }
        if ((sub === "add" || sub === "remove") && item && args.length === 2) {
          if (sub === "add") {
            const r = addFastTrack(db, "cli", item);
            console.log(r.added ? `${refText(r.ref)}: fast-tracked` : `${refText(r.ref)}: already fast-tracked`);
          } else {
            const r = removeFastTrack(db, "cli", item);
            console.log(r.removed ? `${refText(r.ref)}: fast track removed` : `${refText(r.ref)}: was not fast-tracked`);
          }
          return;
        }
        throw new FastTrackError("usage: fasttrack add <url|repo#n> | remove <url|repo#n> | list");
      } catch (e) {
        if (!(e instanceof FastTrackError)) throw e;
        console.error(e.message);
        process.exit(1);
      }
    },
  },
};
