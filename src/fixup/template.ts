// Texts the fix-up step writes on GitHub. No Node imports: the prompt registry
// (also loaded by the web mockup) shows the comment templates on the Prompts page.
import { cleanReason } from "../act/templates.ts";

/** The one comment posted on the PR after a push; `{{files}}` is the comma-separated list of changed paths. */
export const COMMENT_TEMPLATE = "Pushed the small fixes from review: {{files}}.";

export function commentText(files: string[]): string {
  return COMMENT_TEMPLATE.replace("{{files}}", files.map((f) => `\`${f}\``).join(", "));
}

/** The commit message: a subject and one line per changed file. */
export function commitMessage(files: string[]): string {
  return `Apply review fixes\n\n${files.map((f) => `- ${f}`).join("\n")}\n`;
}

export const HOLD_CANNOT_PUSH = "can't push to the contributor's branch";

/** The one comment posted on a PR we can't push to; `{{fixes}}` is one "- file: change" line per fix. */
export const ASK_TEMPLATE = "Before this can be merged, it needs these changes:\n{{fixes}}";
export const ASK_MAX_ITEMS = 6;
export const ASK_ITEM_MAX = 150;

/** The review's fix list is model-written from untrusted text: no links or mentions, capped in count and length. */
export function askText(fixes: { file: string; change: string }[]): string {
  const items = fixes.slice(0, ASK_MAX_ITEMS).flatMap((f) => {
    const change = cleanReason(f.change);
    if (!change) return [];
    const line = `\`${f.file.replace(/[`\s]/g, "")}\`: ${change}`;
    return [`- ${line.length > ASK_ITEM_MAX - 2 ? `${line.slice(0, ASK_ITEM_MAX - 3).trimEnd()}…` : line}`];
  });
  return ASK_TEMPLATE.replace("{{fixes}}", items.join("\n"));
}
