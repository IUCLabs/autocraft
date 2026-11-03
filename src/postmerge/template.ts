// The issue the postmerge-file step opens for a defect. Fixed layout; the variable parts are the PR number, the finding's
// own text (untrusted model output, cleaned) and the model name. No Node imports: the Prompts page lists the template.
import { cleanLine, modelLabel } from "../review/post-template.ts";

export const ISSUE_TITLE_MAX = 120;
export const ISSUE_BODY_MAX = 6000;

export const ISSUE_TEMPLATE = "_AI-generated review ({model}). Not a maintainer decision._\n\nFollow-up to #{number}.\n\n{body}";

/** Raw HTML tags and mentions out (nobody gets pinged); Markdown and line breaks stay. */
function cleanBody(s: string): string {
  return s.replace(/(^|[^A-Za-z0-9_])@(?=[A-Za-z0-9_])/g, "$1").replace(/<\/?[A-Za-z][^>]*>/g, "").trim();
}

export function issueTitle(title: string): string {
  return cleanLine(title, ISSUE_TITLE_MAX);
}

export function issueBody(o: { number: number; model: string | null; body: string; file: string | null; line: number | null }): string {
  const where = o.file ? `\n\nLocation: \`${o.file.replace(/`/g, "")}${o.line ? `:${o.line}` : ""}\`` : "";
  const text = `${cleanBody(o.body)}${where}`.slice(0, ISSUE_BODY_MAX);
  return `_AI-generated review (${modelLabel(o.model)}). Not a maintainer decision._\n\nFollow-up to #${o.number}.\n\n${text}\n`;
}
