// The Markdown review the review-post step posts on a pull request. Fixed layout:
// the variable parts are the model name, the verdict wording, the review's own text
// (cleaned: it is untrusted model output) and the short head commit. No Node imports:
// the Prompts page lists the template through src/act/templates.ts.

export const REVIEW_BODY_MAX = 6000;
const ITEM_MAX = 600;
const MAX_FIXES = 20;
const MAX_RISKS = 6;

/** "claude-opus-5-5" -> "Opus 5.5", "claude-opus-4-1-20250805" -> "Opus 4.1", "opus" -> "Opus". Other ids are returned as they are. */
export function modelLabel(id: string | null | undefined): string {
  const t = (id ?? "").trim();
  const m = /^(?:claude-)?(opus|sonnet|haiku)(?:-(\d+)(?:-(\d{1,2}))?)?(?:-\d{8})?(?:\[[^\]]*\])?$/i.exec(t);
  if (!m) return t || "unknown model";
  const name = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1).toLowerCase();
  return m[2] ? `${name} ${m[2]}${m[3] ? `.${m[3]}` : ""}` : name;
}

const VERDICT_LINE: Record<string, string> = {
  take: "No blocking problems found.",
  "take-fix": "Small fixes needed before merging:",
  hold: "Changes needed:",
  close: "This does not look mergeable as it is:",
};

/** One line of plain text: no mentions (nobody gets pinged), no raw HTML tags, cut to `max` characters. */
export function cleanLine(s: string | null | undefined, max = ITEM_MAX): string {
  const t = (s ?? "")
    .replace(/(^|[^A-Za-z0-9_])@(?=[A-Za-z0-9_])/g, "$1")
    .replace(/<\/?[A-Za-z][^>]*>/g, "")
    .replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

export type ReviewPostInput = {
  model: string | null;
  verdict: string;
  sure: boolean;
  reason: string | null;
  fixes: { file: string; change: string }[];
  risks: string[];
  head: string;
};

export function reviewBody(r: ReviewPostInput): string {
  const head = `_AI-generated review (${modelLabel(r.model)}). Not a maintainer decision._\n\n${VERDICT_LINE[r.verdict] ?? "Review:"}${r.sure ? "" : " The review was not certain."}`;
  const foot = `Reviewed at ${/^[0-9a-f]+$/i.test(r.head) ? r.head.slice(0, 7) : r.head}.`;
  const items: string[] = [];
  const reason = cleanLine(r.reason);
  if (reason) items.push(`- ${reason}`);
  for (const f of r.fixes.slice(0, MAX_FIXES)) {
    const file = cleanLine(f.file, 200).replace(/`/g, "'");
    const change = cleanLine(f.change);
    if (file || change) items.push(file ? `- \`${file}\`: ${change}` : `- ${change}`);
  }
  for (const k of r.risks.slice(0, MAX_RISKS)) {
    const line = cleanLine(k);
    if (line) items.push(`- ${line}`);
  }
  const fixed = head.length + foot.length + 8;
  const kept: string[] = [];
  let used = fixed;
  for (const line of items) {
    if (used + line.length + 1 > REVIEW_BODY_MAX) {
      kept.push("- …");
      break;
    }
    kept.push(line);
    used += line.length + 1;
  }
  return `${head}\n\n${kept.length ? `${kept.join("\n")}\n\n` : ""}${foot}`;
}
