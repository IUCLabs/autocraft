// The repository files a CI workflow runs: relative paths named in its `run:` steps. Pure, no imports.

/**
 * The text of every `run:` step of a workflow file (the inline value, or the indented block after `run: |` or `run: >`),
 * and `<dir>/` for every local action a step uses (`uses: ./dir`).
 */
export function workflowRuns(yaml: string): string[] {
  const out: string[] = [];
  const lines = yaml.replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const u = /^\s*(?:-\s+)?uses:\s*["']?\.\/([^\s"'#]+)/.exec(lines[i]!);
    if (u) { out.push(`${u[1]!.replace(/\/+$/, "")}/`); continue; }
    const m = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(lines[i]!);
    if (!m) continue;
    const v = m[2]!.trim();
    if (!/^[|>][-+0-9]*\s*(#.*)?$/.test(v)) { out.push(v); continue; }
    const indent = m[1]!.length;
    const block: string[] = [];
    for (i++; i < lines.length; i++) {
      const l = lines[i]!;
      if (l.trim() && l.length - l.trimStart().length <= indent) { i--; break; }
      block.push(l);
    }
    out.push(block.join("\n"));
  }
  return out;
}

/**
 * The repo-relative paths named in run text: tokens split at shell punctuation, with a leading `./` removed. An entry ending
 * in `/` is a local action's directory. Manifests and lockfiles are left out: their own rules read what changes in them.
 */
export function runPaths(runs: string[]): Set<string> {
  const out = new Set<string>();
  for (const r of runs) for (const t of r.replace(/\$\{\{\s*github\.workspace\s*\}\}\//g, "").split(/[\s;&|()<>"'`=,]+/)) {
    const p = t.replace(/^(\.\/)+/, "");
    if (p && !p.startsWith("/") && !p.startsWith("-") && !p.includes("..") && !p.includes("$") && !OWN_RULES.test(p)) out.add(p);
  }
  return out;
}

const OWN_RULES = /(^|\/)(Cargo\.toml|Cargo\.lock|package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|pyproject\.toml|uv\.lock|poetry\.lock|go\.mod|go\.sum)$/;

/** Paths that look like scripts a workflow could run; with the workflows unread, a change to one needs a person. */
export const SCRIPT_LIKE = /\.(sh|bash|ps1)$|(^|\/)(scripts?|ci)\//i;

/** Whether a changed file is one the workflows run: named in a run step, or inside a local action's directory. */
export function runByWorkflow(path: string, named: Set<string>): boolean {
  if (named.has(path)) return true;
  for (const n of named) if (n.endsWith("/") && path.startsWith(n)) return true;
  return false;
}
