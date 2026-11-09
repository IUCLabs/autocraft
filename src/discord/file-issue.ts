// Filing a drafted issue from Discord under the person's own GitHub account: the reporter sign-in, the junk check and
// the limits. The Discord flow (src/discord/issue-new.ts) calls fileIssue() when the person presses File it.
import type { DatabaseSync } from "node:sqlite";

export type IssueKind = "bug" | "feature";

export type FileRequest = {
  /** Keyed hash of the Discord user (`keys.hash("author", id)`). */
  reporter: string;
  repo: string;
  title: string;
  body: string;
  kind: IssueKind;
};

export type FileResult =
  /** The person has not signed in with GitHub (or the sign-in expired): show a link button to `url`. */
  | { status: "sign-in"; url: string }
  | { status: "filed"; number: number; url: string; login: string }
  /** Not filed: a limit, the junk check or a GitHub error. `reason` is shown to the person; the flow offers the GitHub link instead. */
  | { status: "refused"; reason: string };

export type FileDeps = { db: DatabaseSync; log: (line: string) => void };

export async function fileIssue(_deps: FileDeps, _req: FileRequest): Promise<FileResult> {
  return { status: "refused", reason: "Filing from Discord is not available yet." };
}

/** Removes the person's GitHub sign-in (on /autocraft unlink and `discord forget --user`). Returns whether one existed. */
export function forgetReporter(_db: DatabaseSync, _reporter: string): boolean {
  return false;
}
