// Which logins are bots for the review stage. Imports nothing but the environment reader, so the database layer can use it.
import { envVar } from "../env.ts";

/** Review bots whose accounts do not carry GitHub's Bot type or a `[bot]` suffix; `AUTOCRAFT_REVIEW_BOTS` (comma-separated logins) replaces the list. */
const DEFAULT_REVIEW_BOTS = ["coderabbitai"];

/** The configured review bot logins, lower case. */
export const reviewBots = (): string[] => (envVar("REVIEW_BOTS")?.split(",") ?? DEFAULT_REVIEW_BOTS).map((x) => x.trim().toLowerCase()).filter(Boolean);

export function isBotLogin(login: string): boolean {
  const list = reviewBots();
  const l = login.toLowerCase();
  return l.endsWith("[bot]") || list.includes(l.replace(/\[bot\]$/, ""));
}
