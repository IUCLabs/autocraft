// The PR's own change as the lines it adds and removes, without the context lines and line numbers that a merge of the base branch moves.
import { createHash } from "node:crypto";

/** Per file: the header lines that say more than the text (mode, rename, binary) and each hunk's added and removed lines. */
type Parsed = Map<string, string[]>;

const META = /^(new file mode|deleted file mode|old mode|new mode|rename from|rename to|Binary files|GIT binary patch)/;

function parse(diff: string): Parsed {
  const out: Parsed = new Map();
  let hunks: string[] | null = null, cur: string[] | null = null;
  const flush = () => { if (cur?.length && hunks) hunks.push(cur.join("\n")); cur = null; };
  for (const line of diff.split("\n")) {
    const m = /^diff --git a\/.+? b\/(.+)$/.exec(line);
    if (m) { flush(); hunks = []; out.set(m[1]!, hunks); continue; }
    if (!hunks) continue;
    if (line.startsWith("@@")) { flush(); cur = []; continue; }
    if (!cur) { if (META.test(line)) hunks.push(`# ${line}`); continue; }
    if ((line.startsWith("+") || line.startsWith("-")) && !line.startsWith("\\")) cur.push(line);
  }
  flush();
  return out;
}

/** A hash of what the diff adds and removes, equal for two diffs whose changes are the same lines whatever the surrounding context. */
export function ownDiffKey(diff: string): string {
  const h = createHash("sha256");
  for (const [path, hunks] of [...parse(diff)].sort((a, b) => (a[0] < b[0] ? -1 : 1))) h.update(`${path}\0${hunks.join("\0")}\0\0`);
  return h.digest("hex");
}

/** The hunks of `after` whose added and removed lines are not a hunk of `before`, as a diff text; empty when every hunk is there. */
export function changedHunks(before: string, after: string): string {
  const was = parse(before);
  const lines = after.split("\n");
  const out: string[] = [];
  let file: string | null = null, header: string[] = [], hunk: string[] = [], shown = false;
  const body = (h: string[]) => h.filter((l) => l.startsWith("+") || l.startsWith("-")).join("\n");
  const endHunk = () => {
    if (!file || !hunk.length) { hunk = []; return; }
    if (!(was.get(file) ?? []).includes(body(hunk))) {
      if (!shown) { out.push(...header); shown = true; }
      out.push(...hunk);
    }
    hunk = [];
  };
  for (const line of lines) {
    const m = /^diff --git a\/.+? b\/(.+)$/.exec(line);
    if (m) { endHunk(); file = m[1]!; header = [line]; shown = false; continue; }
    if (!file) continue;
    if (line.startsWith("@@")) { endHunk(); hunk = [line]; continue; }
    if (hunk.length) hunk.push(line);
    else header.push(line);
  }
  endHunk();
  return out.length ? `${out.join("\n")}\n` : "";
}

/**
 * What a review owes a head made by our merge of the base branch. The reviewer reads the PR's own diff, which the merge leaves as it was
 * unless the conflict resolution changed it: unchanged, the earlier verdict carries; changed, only those hunks are read; unknown, the whole diff.
 */
export function reviewAfterBaseMerge(ownDiff: string | null): "carry" | "delta" | "full" {
  return ownDiff === "same" ? "carry" : ownDiff === "changed" ? "delta" : "full";
}
