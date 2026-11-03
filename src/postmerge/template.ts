// The issue the postmerge-file step opens for a defect. Fixed layout; the variable parts are the PR number, the finding's
// own text (untrusted model output, cleaned) and the model name. No Node imports: the Prompts page lists the template.
import { cleanLine, modelLabel } from "../review/post-template.ts";

export const ISSUE_TITLE_MAX = 120;
export const ISSUE_BODY_MAX = 6000;

export const ISSUE_TEMPLATE = "_AI-generated review ({model}). Not a maintainer decision._\n\nFollow-up to #{number}.\n\n{body}\n\nLocation: `{file}:{line}` (only when the finding names a file)";

/** Fenced blocks and inline code spans; the capturing group makes split() keep them at odd indices. */
const CODE = /(```[\s\S]*?(?:```|$)|`[^`\n]*`)/;

/** `fix` runs on the text outside code only: code keeps its URLs, references and `@`. */
function outsideCode(s: string, fix: (t: string) => string): string {
  return s.split(CODE).map((part, i) => (i % 2 ? part : fix(part))).join("");
}

/**
 * Public text outside code: no raw HTML, no mentions, no URLs, Markdown links reduced to their text, and no issue
 * references (`owner/repo#n`, `#n`), which would link or notify other threads. A reference reads "issue n".
 */
function cleanOutsideCode(t: string): string {
  return t
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<\/?[A-Za-z][^>]*>/g, "")
    .replace(/<?\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s<>]*>?/gi, "")
    .replace(/(^|[^A-Za-z0-9_])@(?=[A-Za-z0-9_])/g, "$1")
    .replace(/(\b(?:issues?|pull requests?|PRs?)\s+)?(?<![\w/])(?:[\w.-]+\/[\w.-]+)?#(\d+)\b/gi, (_m, pre: string | undefined, n: string) => (pre ? `${pre}${n}` : `issue ${n}`));
}

const cleanBody = (s: string): string => outsideCode(s, cleanOutsideCode).trim();

export function issueTitle(title: string): string {
  return cleanLine(outsideCode(title, cleanOutsideCode), ISSUE_TITLE_MAX);
}

/** Why a title or body must not be filed: it names the product or the pipeline's account. Null when it is fine. */
export function refusal(texts: string[], login: string): string | null {
  const all = texts.join("\n");
  if (/autocraft/i.test(all)) return "the text names the product";
  if (login && new RegExp(`(?<![\\w-])${login.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "i").test(all)) return "the text names the pipeline's account";
  return null;
}

export function issueBody(o: { number: number; model: string | null; body: string; file: string | null; line: number | null }): string {
  const where = o.file ? `\n\nLocation: \`${o.file.replace(/`/g, "")}${o.line ? `:${o.line}` : ""}\`` : "";
  const text = `${cleanBody(o.body)}${where}`.slice(0, ISSUE_BODY_MAX);
  return `_AI-generated review (${modelLabel(o.model)}). Not a maintainer decision._\n\nFollow-up to #${o.number}.\n\n${text}\n`;
}
