// craft-auto conversation show|say|do: the operator's conversation actions from the shell.
import { parseRef } from "../classify/parse.ts";
import { connect } from "../db.ts";
import { doCard } from "./act.ts";
import { githubDiff, runConversations } from "./run.ts";
import { ConversationError, addOperatorMessage, turnsOf } from "./store.ts";

const USAGE = "usage: craft-auto conversation show <repo>#<n> | say <repo>#<n> <text> [--by LOGIN] [--now] | do <card-id> --by LOGIN";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export const commands = {
  conversation: {
    summary: "conversation show <repo>#<n> | say <repo>#<n> <text> [--by LOGIN] [--now] | do <card-id> --by LOGIN: read, write in, or run a card of an item's Opus conversation",
    async run(args: string[]): Promise<void> {
      const [sub, target] = args;
      const db = connect();
      try {
        if (sub === "do") {
          const by = flag(args, "--by"), id = Number(target);
          if (!Number.isInteger(id) || !by) throw new ConversationError(2, USAGE);
          const r = await doCard(db, id, by);
          console.log(r.ran ? `card ${id}: ${r.card.state}${r.card.error ? `: ${r.card.error}` : ""}${r.card.result_url ? ` ${r.card.result_url}` : ""}` : `card ${id} is already ${r.card.state}; nothing done`);
          return;
        }
        const ref = parseRef(target ?? "");
        if (!ref || (sub !== "show" && sub !== "say")) throw new ConversationError(2, USAGE);
        if (sub === "say") {
          const by = flag(args, "--by") ?? "cli";
          const text = args.slice(2).filter((a, i, all) => a !== "--now" && a !== "--by" && all[i - 1] !== "--by").join(" ");
          await addOperatorMessage(db, ref.repo, ref.number, by, text, { diff: githubDiff });
          console.log(`${ref.repo}#${ref.number}: message queued; the Conversation step answers it`);
          if (args.includes("--now")) console.log(`${(await runConversations(db, { limit: 1 })).answered} answered`);
        }
        for (const t of turnsOf(db, ref.repo, ref.number)) {
          console.log(`\n[${t.id}] ${t.login} ${t.at}${t.status ? ` (${t.status})` : ""}\n${t.body}`);
          for (const c of db.prepare("SELECT id, state, description, text FROM conversation_cards WHERE turn_id = ? ORDER BY id").all(t.id) as { id: number; state: string; description: string; text: string | null }[]) {
            console.log(`  card ${c.id} [${c.state}] ${c.description}${c.text ? `\n    ${c.text.replace(/\n/g, "\n    ")}` : ""}`);
          }
        }
      } catch (e) {
        if (!(e instanceof ConversationError)) throw e;
        console.error(e.message);
        process.exit(e.status === 2 ? 2 : 1);
      }
    },
  },
};
