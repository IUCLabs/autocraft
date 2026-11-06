// The public privacy page of the optional Discord mention counting. No sign-in, no data from the database but the
// operators' contact text, and no external request.
import { esc, plainPage } from "./util.ts";

export const DISCORD_PRIVACY_PATH = "/discord-privacy";

export function discordPrivacyPage(nonce: string, contact: string): string {
  const who = contact.trim()
    ? `<p>To ask for deletion, contact: ${esc(contact.trim())}. Send the link to your Discord message, or your Discord user ID.</p>`
    : `<p>To ask for deletion, contact the operators of this AutoCraft instance. Send the link to your Discord message, or your Discord user ID.</p>`;
  return plainPage(nonce, "Discord bot privacy", `<style nonce="${nonce}">main{max-width:38rem}h2{font-size:15px;margin:18px 0 4px}ul{margin:4px 0;padding-left:20px}</style>
<p>This bot counts how often GitHub issues and pull requests are mentioned in the Discord channels its operators choose.</p>
<h2>What it reads</h2>
<p>New, edited and deleted messages in the chosen channels, as Discord delivers them. It does not read message history, direct messages or other channels.</p>
<h2>What it keeps</h2>
<ul><li>Which tracked item a message names: a GitHub issue or pull request link, or <code>repo#123</code>.</li>
<li>The message's server, channel, ID and time, encrypted.</li></ul>
<h2>What it never keeps</h2>
<ul><li>Message text.</li><li>Names, avatars or profiles of people.</li><li>Counts or lists per person.</li></ul>
<p>It never posts in Discord.</p>
<h2>Deleting a record</h2>
<p>Deleting a message in Discord removes its record. Editing a message so it no longer names the item removes it too.</p>
${who}`);
}
