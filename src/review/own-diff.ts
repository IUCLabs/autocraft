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

/** True when the diff touches a binary file, whose content the added and removed lines do not show. */
export const hasBinary = (diff: string): boolean => /^(Binary files |GIT binary patch)/m.test(diff);

/**
 * What the PR's diff changed from `before` to `after`, as diff text: the hunks of `after` that are not in `before` (with their file headers, which also
 * shows a mode or rename change), then a section of the PR's earlier hunks that `after` no longer has. Empty when nothing changed.
 */
export function changedHunks(before: string, after: string): string {
  const was = parse(before), now = parse(after);
  const out: string[] = [];
  let file: string | null = null, header: string[] = [], hunk: string[] = [], shown = false;
  const body = (h: string[]) => h.filter((l) => l.startsWith("+") || l.startsWith("-")).join("\n");
  const show = () => { if (!shown) { out.push(...header); shown = true; } };
  const endHunk = () => {
    if (file && hunk.length && !(was.get(file) ?? []).includes(body(hunk))) { show(); out.push(...hunk); }
    hunk = [];
  };
  const endFile = () => {
    endHunk();
    if (!file) return;
    const metaOf = (m: string[]) => m.filter((h) => h.startsWith("# ")).sort().join("\n");
    if (metaOf(was.get(file) ?? []) !== metaOf(now.get(file) ?? [])) show();
  };
  for (const line of after.split("\n")) {
    const m = /^diff --git a\/.+? b\/(.+)$/.exec(line);
    if (m) { endFile(); file = m[1]!; header = [line]; shown = false; continue; }
    if (!file) continue;
    if (line.startsWith("@@")) { endHunk(); hunk = [line]; continue; }
    if (hunk.length) hunk.push(line);
    else header.push(line);
  }
  endFile();
  const gone: string[] = [];
  for (const [path, hunks] of was) {
    const kept = new Set(now.get(path) ?? []);
    const lost = hunks.filter((h) => !h.startsWith("# ") && !kept.has(h));
    if (lost.length) gone.push(`diff --git a/${path} b/${path}`, ...lost.flatMap((h) => ["@@ PR change no longer in the diff @@", h]));
  }
  if (gone.length) out.push(...gone);
  return out.length ? `${out.join("\n")}\n` : "";
}

/**
 * What a review owes a head made by our merge of the base branch. The reviewer reads the PR's own diff, which the merge leaves as it was
 * unless the conflict resolution changed it: unchanged, the earlier verdict carries; changed, only those hunks are read; unknown, the whole diff.
 */
export function reviewAfterBaseMerge(ownDiff: string | null): "carry" | "delta" | "full" {
  return ownDiff === "same" ? "carry" : ownDiff === "changed" ? "delta" : "full";
}
