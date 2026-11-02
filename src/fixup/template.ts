// Texts the fix-up step writes on GitHub. No Node imports: the prompt registry
// (also loaded by the web mockup) shows the comment template on the Prompts page.

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
