// `/autocraft search repo:<repo|all> query:<text>` and the message command "Find issue". Replies are visible to the caller only.
import type { DatabaseSync } from "node:sqlite";
import type { Call, Interactions } from "./interactions.ts";
import type { DiscordKeys } from "./keys.ts";
import { publicRepoNames } from "../public/status.ts";
import { renderMatches } from "./reply.ts";
import { QUESTION_CHARS, type Search } from "./search.ts";

export const FIND_ISSUE = "Find issue";
const ALL_REPOS = "all";

export function installSearchCommands(ix: Interactions, deps: { db: DatabaseSync; keys: DiscordKeys; search: Search }): void {
  const { db, keys, search } = deps;
  const run = async (call: Call, text: string | undefined, repo?: string): Promise<void> => {
    const question = (text ?? "").replace(/\s+/g, " ").trim().slice(0, QUESTION_CHARS);
    if (!question) return void (await call.edit({ content: "There is no text to search with." }));
    const i = call.interaction;
    if (!search.allow(keys.hash("author", call.userId ?? "?"), keys.hash("channel", i.channel_id ?? "?"))) return void (await call.edit({ content: "Too many searches just now. Try again in a minute." }));
    const found = await search.find(question, repo);
    const r = renderMatches(db, found.matches, question, i.channel_id);
    await call.edit({ content: r.content, components: r.components });
  };
  ix.command("autocraft search", {
    name: "autocraft", type: 1, description: "AutoCraft", dm_permission: false,
    // Both fields are required so Discord shows them at once; "All repos" keeps a search across every public repo one pick away.
    options: [{ type: 1, name: "search", description: "Search the issues for a question or a description", options: [
      { type: 3, name: "repo", description: "The repo to search, or All repos", required: true, autocomplete: true },
      { type: 3, name: "query", description: "What to look for", required: true, max_length: 500 },
    ] }],
  }, (call) => {
    const repo = call.option("repo")?.trim();
    return run(call, call.option("query"), repo && repo !== ALL_REPOS ? repo : undefined);
  });
  ix.autocomplete("autocraft search", (call) => {
    const typed = (call.focused()?.value ?? "").toLowerCase();
    const repos = publicRepoNames(db).filter((r) => r.toLowerCase().includes(typed)).map((r) => ({ name: r, value: r }));
    return [{ name: "All repos", value: ALL_REPOS }, ...repos].slice(0, 25);
  });
  ix.command(FIND_ISSUE, { name: FIND_ISSUE, type: 3, dm_permission: false }, (call) => run(call, call.targetText()));
}
