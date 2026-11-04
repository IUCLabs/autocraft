// Content a person looks at before it merges, whatever the review says: the README, brand files, and third-party links or images in docs.
// Pure: it reads a unified diff text. The diff comes from the review's diff cache (see facts.ts).
import { splitDiff } from "../review/diff.ts";

export const README_REASON = "changes the README";
export const UNCHECKED_REASON = "diff not checked for README or third-party links";
export const BRAND_REASON = "changes brand files";
export const EXTERNAL_LINK_REASON = "adds a third-party image or link";

/** Hosts that do not count as third-party, besides the repo's own org pages on GitHub. */
const OWN_HOSTS = ["github.com", "www.github.com", "raw.githubusercontent.com"];

const DOC_FILE = /\.(md|markdown|mdx|html?|rst|adoc|txt)$|(^|\/)docs?\//i;
const README_FILE = /(^|\/)readme[^/]*$/i;
const BRAND_FILE = /brand|logo/i;
const URL_RE = /https?:\/\/([^\s/?#)"'<>\]]+)/gi;

/** The reasons (in a fixed order) this diff keeps a PR outside the merge rule. `org` is the GitHub org of the repo. */
export function sensitiveReasons(diff: string, org: string): string[] {
  const own = new Set([...OWN_HOSTS, `${org}.github.io`].map((h) => h.toLowerCase()));
  let readme = false, brand = false, external = false;
  for (const f of splitDiff(diff)) {
    if (README_FILE.test(f.path)) readme = true;
    if (BRAND_FILE.test(f.path)) brand = true;
    if (external || !DOC_FILE.test(f.path)) continue;
    for (const line of f.text.split("\n")) {
      if (!line.startsWith("+") || line.startsWith("+++")) continue;
      for (const m of line.matchAll(URL_RE)) {
        const host = m[1]!.replace(/^[^@]*@/, "").replace(/:\d+$/, "").toLowerCase();
        if (!own.has(host)) external = true;
      }
    }
  }
  return [...(readme ? [README_REASON] : []), ...(brand ? [BRAND_REASON] : []), ...(external ? [EXTERNAL_LINK_REASON] : [])];
}
