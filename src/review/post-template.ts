// The Markdown review the review-post step posts on a pull request. Fixed layout:
// the variable parts are the model name, the verdict wording, the review's own text
// (cleaned: it is untrusted model output) and the short head commit. No Node imports:
// the Prompts page lists the template through src/act/templates.ts.

export const REVIEW_BODY_MAX = 6000;
const ITEM_MAX = 600;
const MAX_POINTS = 8;

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
  "take-fix": "Small fixes needed:",
  hold: "Changes needed:",
  close: "Significant problems found:",
};

/** One line of plain text: no mentions (nobody gets pinged), no raw HTML tags, cut to `max` characters. */
export function cleanLine(s: string | null | undefined, max = ITEM_MAX): string {
  const t = (s ?? "")
    .replace(/(^|[^A-Za-z0-9_])@(?=[A-Za-z0-9_])/g, "$1")
    .replace(/<\/?[A-Za-z][^>]*>/g, "")
    .replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** What the pipeline will do next with the PR, as far as the posting moment shows. */
export type RecommendInput = {
  verdict: string;
  /** The PR's merge queue entry (take and take-fix reviews only), or null when it has none. */
  queue: { path: "rule" | "operator" | null; state: string } | null;
  mergeApproved: boolean;
  /** Push approval for the repo and maintainers allow edits on the PR. */
  canPush: boolean;
};

const WAIT = "Recommendation: wait for maintainer feedback.";

/** The closing line of the review. Plain wording only: no rule details, tiers or account names. */
export function recommendation(r: RecommendInput): string {
  switch (r.verdict) {
    case "take":
      if (!r.queue || r.queue.state === "declined" || r.queue.state === "merged") return WAIT;
      return r.queue.path === "rule" && r.mergeApproved
        ? "Recommendation: merge after CI and checks pass."
        : "Recommendation: merge, after a maintainer's decision.";
    case "take-fix":
      return r.canPush
        ? "Recommendation: merge after the fixes above; they may be pushed to this branch."
        : "Recommendation: merge after the fixes above.";
    case "hold":
      return "Recommendation: update the pull request; it will be reviewed again.";
    default:
      return WAIT;
  }
}

export type ReviewPostInput = {
  model: string | null;
  verdict: string;
  sure: boolean;
  /** The Opus `public` field: the only review text that is posted. */
  summary: string;
  points: string[];
  head: string;
  /** The closing `Recommendation: …` line (see `recommendation`). */
  recommendation: string;
};

export function reviewBody(r: ReviewPostInput): string {
  const head = `_AI-generated review (${modelLabel(r.model)}). Not a maintainer decision._\n\n${VERDICT_LINE[r.verdict] ?? "Review:"}${r.sure ? "" : " The review was not certain."}`;
  const foot = `Reviewed at ${/^[0-9a-f]+$/i.test(r.head) ? r.head.slice(0, 7) : r.head}.`;
  const summary = cleanLine(r.summary);
  const items: string[] = [];
  for (const p of r.points.slice(0, MAX_POINTS)) {
    const line = cleanLine(p);
    if (line) items.push(`- ${line}`);
  }
  const rec = r.recommendation;
  const fixed = head.length + rec.length + foot.length + summary.length + 8;
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
  return `${head}\n\n${summary ? `${summary}\n\n` : ""}${kept.length ? `${kept.join("\n")}\n\n` : ""}${rec}\n\n${foot}`;
}
