// Content a person looks at before it merges, whatever the review says: the README, brand files, and third-party links or images in docs.
// Pure: it reads a unified diff text. The diff comes from the review's diff cache (see facts.ts).
import { splitDiff } from "../review/diff.ts";

export const README_REASON = "changes the README";
export const UNCHECKED_REASON = "diff not checked for README or third-party links";
export const BRAND_REASON = "changes brand files";
export const CI_FILES_REASON = "changes CI or build configuration";
export const EXTERNAL_LINK_REASON = "adds a third-party image or link";

/** Hosts that do not count as third-party, besides the repo's own org pages on GitHub. */
const OWN_HOSTS = ["github.com", "www.github.com", "raw.githubusercontent.com"];

const DOC_FILE = /\.(md|markdown|mdx|html?|rst|adoc|txt)$|(^|\/)docs?\//i;
const README_FILE = /(^|\/)readme[^/]*$/i;
const CI_FILE = /(^|\/)(\.github\/workflows\/|\.cargo\/|build\.rs$)/;
const CARGO_FILE = /(^|\/)Cargo\.toml$/;
const CARGO_RISK = /^\s*(build\s*=|links\s*=|proc-macro\b|\[(target\.[^\]]*\.)?build-dependencies|\[patch|\[replace|(git|registry|registry-index)\s*=|.*[{,]\s*(git|registry|registry-index)\s*=)/;
const PATH_KEY = /\bpath\s*=\s*"([^"]*)"/g;

/** A changed Cargo.toml line that adds a build script, a patched or non-registry source, or a path leaving the repo. */
function cargoRisk(f: { path: string; text: string }): boolean {
  const depth = f.path.split("/").length - 1;
  for (const line of f.text.split("\n")) {
    if (!/^[+-]/.test(line) || line.startsWith("+++") || line.startsWith("---")) continue;
    const body = line.slice(1);
    if (CARGO_RISK.test(body)) return true;
    for (const m of body.matchAll(PATH_KEY)) {
      const p = m[1]!;
      if (p.startsWith("/") || p.split("/").filter((x) => x === "..").length > depth) return true;
    }
  }
  return false;
}
const BRAND_FILE = /brand|logo/i;
const URL_RE = /https?:\/\/([^\s/?#)"'<>\]]+)/gi;

/** The reasons (in a fixed order) this diff keeps a PR outside the merge rule. `org` is the GitHub org of the repo. */
export function sensitiveReasons(diff: string, org: string): string[] {
  const own = new Set([...OWN_HOSTS, `${org}.github.io`].map((h) => h.toLowerCase()));
  let readme = false, brand = false, ci = false, external = false;
  for (const f of splitDiff(diff)) {
    if (README_FILE.test(f.path)) readme = true;
    if (BRAND_FILE.test(f.path)) brand = true;
    if (CI_FILE.test(f.path) || (CARGO_FILE.test(f.path) && cargoRisk(f))) ci = true;
    if (external || !DOC_FILE.test(f.path)) continue;
    for (const line of f.text.split("\n")) {
      if (!line.startsWith("+") || line.startsWith("+++")) continue;
      for (const m of line.matchAll(URL_RE)) {
        const host = m[1]!.replace(/^[^@]*@/, "").replace(/:\d+$/, "").toLowerCase();
        if (!own.has(host)) external = true;
      }
    }
  }
  return [...(readme ? [README_REASON] : []), ...(brand ? [BRAND_REASON] : []), ...(ci ? [CI_FILES_REASON] : []), ...(external ? [EXTERNAL_LINK_REASON] : [])];
}
