// The public privacy page of the optional Discord bot (mention counts, issue search and replies). No sign-in, no data from the database but the
// operators' contact text, and no external request.
import { esc, plainPage } from "./util.ts";

// Discord refuses app URLs that contain its name.
export const DISCORD_PRIVACY_PATH = "/privacy";

export function discordPrivacyPage(nonce: string, contact: string): string {
  const who = contact.trim()
    ? `<p>To ask for deletion, contact: ${esc(contact.trim())}. Send the link to your Discord message, or your Discord user ID.</p>`
    : `<p>To ask for deletion, contact the operators of this AutoCraft instance. Send the link to your Discord message, or your Discord user ID.</p>`;
  return plainPage(nonce, "Discord bot privacy", `<style nonce="${nonce}">main{max-width:38rem}h2{font-size:15px;margin:18px 0 4px}ul{margin:4px 0;padding-left:20px}</style>
<p>This bot counts how often GitHub issues and pull requests are mentioned in the Discord channels its operators choose, and finds matching GitHub issues when someone asks it to.</p>
<h2>What it reads</h2>
<p>New, edited and deleted messages in the chosen channels, as Discord delivers them. It does not read message history, direct messages or other channels. It also receives the commands and buttons people use on it, in any channel.</p>
<h2>When it replies</h2>
<ul><li>When someone mentions the bot in a chosen channel, it replies once, publicly, with up to three GitHub issues that match the message they replied to, or the text of their own message when they did not reply to one. Edited messages get no new reply.</li>
<li>The slash command <code>/issue search</code> and the message command &ldquo;Find issue&rdquo; answer the person who used them, privately.</li>
<li>Answers include a link that opens GitHub&rsquo;s new-issue page with a title taken from the question. Nothing is posted to GitHub by the bot.</li></ul>
<h2>Where the question goes</h2>
<p>The text of a question (the message mentioned or chosen, or what someone typed into the command) is compared with the public issues on this computer. Unless the daily spending limit has been reached, the text and the closest issues are also sent to Anthropic&rsquo;s Claude Haiku model, which picks the best matches and gives a reason for each. The text is used for that one search and then dropped.</p>
<h2>What it keeps</h2>
<ul><li>Which tracked item a message names: a GitHub issue or pull request link, or <code>repo#123</code>.</li>
<li>The message&rsquo;s server, channel, ID and time, encrypted.</li>
<li>For each reply, a scrambled (keyed hash) form of the ID of the message that asked and of the message it quoted, and the encrypted ID of the reply, so the reply can be removed when either message is deleted.</li>
<li>Counts of searches and what they cost, with no text and no person attached.</li></ul>
<h2>What it never keeps</h2>
<ul><li>Message text or the text of a question.</li><li>Names, avatars or profiles of people.</li><li>Counts or lists per person.</li></ul>
<h2>Linking your account</h2>
<p>To link your Discord account to your GitHub login, choose Link Discord in the dashboard&rsquo;s account menu and enter the code it shows with <code>/autocraft link</code> in Discord. The bot then keeps a keyed hash of your Discord user ID (not the ID itself) and your GitHub login, with the time you linked. It is used only to know which dashboard user is asking. The code is single use, expires after 10 minutes and is stored only as a keyed hash until then. To remove the link, run <code>/autocraft unlink</code>, choose Unlink Discord in the account menu, or send a deletion request below.</p>
<h2>Deleting a record</h2>
<p>Deleting a message in Discord removes its record, and so does deleting its channel. Editing a message so it no longer names the item removes it too. When a message that asked the bot, or the message it quoted, is deleted, the bot deletes its reply. If a message is deleted while the bot is offline, its record and reply can remain until a deletion request removes them.</p>
${who}`);
}
