// Texts the CI fix step writes on GitHub. No Node imports.

/** The one comment after a push; `{{files}}` is the comma-separated list of changed paths. */
export const COMMENT_TEMPLATE = "Pushed a fix for the failing CI check: {{files}}.";
export function commentText(files: string[]): string {
  return COMMENT_TEMPLATE.replace("{{files}}", files.map((f) => `\`${f}\``).join(", "));
}

/** The commit message: a subject and one line per changed file. */
export function commitMessage(kind: "format" | "code", files: string[]): string {
  return `${kind === "format" ? "Fix formatting for CI" : "Fix failing CI check"}\n\n${files.map((f) => `- ${f}`).join("\n")}\n`;
}

/** The comment on a PR we can't push to; `{{patch}}` is the diff in a code fence. */
export const ASK_TEMPLATE = "The CI check `{{check}}` fails on this branch. This patch fixes it:\n\n```diff\n{{patch}}```";
export const ASK_PATCH_MAX = 12_000;
export function askText(check: string, patch: string): string {
  const name = check.replace(/[`@\r\n]/g, " ").trim().slice(0, 100) || "CI";
  const body = patch.replace(/```/g, "'''").slice(0, ASK_PATCH_MAX).replace(/\n?$/, "\n");
  // Function replacers: the text may contain `$&` and similar.
  return ASK_TEMPLATE.replace("{{check}}", () => name).replace("{{patch}}", () => body);
}
