// CLI of the post-merge review stage: `autocraft postmerge review <repo>#<n> [--again]` and
// `autocraft postmerge backfill --since <ISO date>`. Operator only: the box's shell is the operator's.
import type { DatabaseSync } from "node:sqlite";
import { audit } from "../dash/audit.ts";
import { mergedPr } from "./select.ts";

const ACTOR = "cli";
const USAGE = "postmerge review <repo>#<n> [--again] | postmerge backfill --since <ISO date>";

/** Reviews one merged PR now; refuses a PR the pipeline did not merge, and one that has a review unless `again`. */
export async function reviewOne(db: DatabaseSync, ref: string, again: boolean, log: (line: string) => void = console.log): Promise<void> {
  const m = /^([A-Za-z0-9._-]+)#([1-9][0-9]*)$/.exec(ref);
  if (!m) throw new Error(`not a repo#number: ${ref}`);
  const repo = m[1]!, number = Number(m[2]);
  if (!mergedPr(db, repo, number)) throw new Error(`${ref} was not merged by the pipeline`);
  if (!again && db.prepare("SELECT 1 FROM postmerge_reviews WHERE repo = ? AND number = ? AND error IS NULL").get(repo, number)) throw new Error(`${ref} has a post-merge review; add --again to review it again`);
  audit(db, ACTOR, "postmerge-review", ref, { again });
  const { runPostmerge } = await import("./review.ts");
  await runPostmerge(db, { repo, only: [number] }, log);
}

export const commands = {
  postmerge: {
    summary: `${USAGE}: post-merge review of pipeline merges`,
    async run(args: string[]): Promise<void> {
      const [sub, ...rest] = args;
      const { connect } = await import("../db.ts");
      if (sub === "review") {
        const again = rest.includes("--again");
        const refs = rest.filter((a) => a !== "--again");
        if (refs.length !== 1 || refs[0]!.startsWith("--")) throw new Error(`usage: autocraft ${USAGE}`);
        await reviewOne(connect(), refs[0]!, again);
      } else if (sub === "backfill") {
        if (rest[0] !== "--since" || rest.length !== 2 || Number.isNaN(Date.parse(rest[1]!))) throw new Error("usage: autocraft postmerge backfill --since <ISO date>");
        const { queueBackfill } = await import("./review.ts");
        const n = queueBackfill(connect(), ACTOR, rest[1]!);
        console.log(`${n} merged PRs wait for a post-merge review; the postmerge step reviews them`);
      } else throw new Error(`usage: autocraft ${USAGE}`);
    },
  },
};
