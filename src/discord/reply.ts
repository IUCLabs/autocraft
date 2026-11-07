// What the bot says about search results: up to three lines, a GitHub link button for each, and a "File a new issue"
// link button. Shared by ping replies and the commands.
import type { DatabaseSync } from "node:sqlite";
import type { Match } from "./search.ts";
import { publicRepoNames } from "../public/status.ts";
import { trackedRepos } from "./store.ts";

const TITLE_CHARS = 80;
const NEW_ISSUE_TITLE_CHARS = 80;
/** Discord accepts link URLs up to 512 characters. */
const URL_MAX = 500;

const oneLine = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** Titles and reasons are plain text in the line: markdown characters are replaced so a title cannot format or link. */
export const plain = (s: string): string => s.replace(/[[\]()<>*_`~|\\#:@]/g, " ").replace(/\s+/g, " ").trim();

/** GitHub's new-issue page with the title filled from the question; the title shrinks until the encoded link fits. */
export function newIssueUrl(repoUrl: string, question: string): string {
  const q = question.replace(/\s+/g, " ").trim();
  let n = NEW_ISSUE_TITLE_CHARS;
  for (;;) {
    const url = `${repoUrl}/issues/new?title=${encodeURIComponent(q.slice(0, n))}`;
    if (url.length <= URL_MAX) return url;
    if (n <= 1) return `${repoUrl}/issues/new`;
    n = Math.floor(n * 0.7);
  }
}

/** The repo whose new-issue page the button opens: the channel's setting (a thread uses its parent's), else the top result's, else the only public tracked repo. Never a private repo. */
export function fileRepoUrl(db: DatabaseSync, channelId: string | undefined, matches: Match[]): string | null {
  const set = channelId === undefined ? undefined : (db.prepare(`SELECT COALESCE(c.default_repo, p.default_repo) AS r FROM discord_channels c
    LEFT JOIN discord_channels p ON p.channel_id = c.parent_id WHERE c.channel_id = ?`).get(channelId) as { r: string | null } | undefined)?.r;
  const names = new Set(publicRepoNames(db));
  const tracked = trackedRepos(db).filter((t) => names.has(t.name));
  const name = (set && names.has(set) ? set : null) ?? (matches[0] && names.has(matches[0].repo) ? matches[0].repo : null) ?? (tracked.length === 1 ? tracked[0]!.name : null);
  const t = tracked.find((x) => x.name === name);
  return t ? `https://github.com/${t.owner}/${t.name}` : null;
}

export type Rendered = { content: string; components: unknown[] };

export function renderMatches(db: DatabaseSync, matches: Match[], question: string, channelId: string | undefined): Rendered {
  const lines = matches.map((m) => `${m.repo}#${m.number} ${oneLine(plain(m.title), TITLE_CHARS)}${m.closed ? " (closed)" : ""}${m.reason ? `\n> ${plain(m.reason)}` : ""}`);
  const buttons: unknown[] = matches.map((m) => ({ type: 2, style: 5, label: `${m.repo}#${m.number}`.slice(0, 80), url: m.url }));
  const repo = fileRepoUrl(db, channelId, matches);
  if (repo) buttons.push({ type: 2, style: 5, label: "File a new issue", url: newIssueUrl(repo, question) });
  return {
    content: lines.length ? lines.join("\n") : "No matching issue found.",
    components: buttons.length ? [{ type: 1, components: buttons }] : [],
  };
}
