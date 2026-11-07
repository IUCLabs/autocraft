// The public terms of use of the optional Discord bot. No sign-in, no data from the database but the operators' contact text.
import { esc, plainPage } from "./util.ts";

export const DISCORD_TERMS_PATH = "/terms";

export function discordTermsPage(nonce: string, contact: string): string {
  const who = contact.trim() ? `contact: ${esc(contact.trim())}` : "contact the operators of this AutoCraft instance";
  return plainPage(nonce, "Discord bot terms of use", `<style nonce="${nonce}">main{max-width:38rem}h2{font-size:15px;margin:18px 0 4px}ul{margin:4px 0;padding-left:20px}</style>
<p>These terms cover the AutoCraft bot on Discord. The bot is run by the operators of this AutoCraft instance for the projects it tracks on GitHub. Using it also means following Discord&rsquo;s own terms and the rules of the server you use it in.</p>
<h2>What the bot does</h2>
<ul><li>Finds GitHub issues that match a question (<code>/issue search</code>, the &ldquo;Find issue&rdquo; message command, or a mention of the bot).</li>
<li>Shows where an issue or pull request is in AutoCraft (<code>/autocraft status</code>) and counts per repo (<code>/autocraft stats</code>).</li>
<li>Counts how often issues and pull requests are mentioned in the channels its operators choose.</li>
<li>Links a Discord account to a dashboard login (<code>/autocraft link</code>, <code>/autocraft unlink</code>).</li></ul>
<h2>Using it</h2>
<ul><li>The bot is free to use. It has limits per person, per channel and per day; when a limit is reached it answers with fewer details or not at all.</li>
<li>Don&rsquo;t use it to flood channels, to get around its limits, or to send it content you have no right to share.</li>
<li>Search results are suggestions picked by a model and can be wrong. Check the issue on GitHub before relying on it.</li>
<li>The bot never posts to GitHub. Filing an issue happens on GitHub, under your own account.</li></ul>
<h2>Your data</h2>
<p>What the bot reads, keeps and deletes is described in the <a href="/privacy">privacy notice</a>.</p>
<h2>Changes and ending</h2>
<p>The operators may change the bot or these terms, limit or stop anyone&rsquo;s use, or switch the bot off at any time. The bot is offered as it is, with no guarantee that it is available or correct.</p>
<h2>Questions</h2>
<p>For questions about these terms, ${who}.</p>`);
}
