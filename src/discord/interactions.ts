// Slash commands, message commands and buttons. Commands register here with their handlers; the table is keyed by
// command name (plus subcommand) or by the custom_id prefix of a component, so later commands plug in with `command`
// and `component`. Every interaction is answered with a deferral within the 3 second limit and then edited, so a
// handler may take as long as it needs (the response stays editable for 15 minutes). Guild commands are
// registered when the bot sees a guild.
import { createHash } from "node:crypto";
import type { CommandDef, DiscordRest, EditBody } from "./rest.ts";

export type Interaction = {
  id: string; token: string; type: number; application_id?: string; guild_id?: string; channel_id?: string;
  member?: { user?: { id: string } }; user?: { id: string };
  data?: {
    name?: string; type?: number; custom_id?: string; target_id?: string;
    options?: { name: string; type: number; value?: unknown; options?: { name: string; type: number; value?: unknown }[] }[];
    resolved?: { messages?: Record<string, { content?: string }> };
  };
};

export type Call = {
  interaction: Interaction;
  /** The Discord user id of whoever pressed it. */
  userId: string | null;
  /** The value of an option of the invoked (sub)command, when it is text. */
  option(name: string): string | undefined;
  /** The text of the message a message command was used on. */
  targetText(): string | undefined;
  /** Replaces the deferred response. */
  edit(body: EditBody): Promise<void>;
};

export type Handler = (call: Call) => Promise<void>;
type Entry = { handler: Handler; ephemeral: boolean };

const COMMAND = 2, COMPONENT = 3, MESSAGE_COMMAND = 3;

export class Interactions {
  #rest: DiscordRest;
  #log: (line: string) => void;
  #commands = new Map<string, Entry>();
  #components = new Map<string, Entry>();
  #defs: CommandDef[] = [];
  #appId: string | null = null;
  #registered = new Map<string, string>();

  constructor(rest: DiscordRest, log: (line: string) => void) {
    this.#rest = rest;
    this.#log = log;
  }

  /**
   * Adds a command. `key` is the command name, with the subcommand after a space ("issue search"); it is the
   * definition's name for a command without subcommands. A definition may be given once per name: handlers of other
   * subcommands of the same command pass `def` as null.
   */
  command(key: string, def: CommandDef | null, handler: Handler, opts: { ephemeral?: boolean } = {}): void {
    this.#commands.set(key, { handler, ephemeral: opts.ephemeral ?? true });
    if (def && !this.#defs.some((d) => d.name === def.name && d.type === def.type)) this.#defs.push(def);
  }

  /** Adds a handler for the buttons whose custom_id is `prefix` or starts with `prefix:`. */
  component(prefix: string, handler: Handler, opts: { ephemeral?: boolean } = {}): void {
    this.#components.set(prefix, { handler, ephemeral: opts.ephemeral ?? true });
  }

  /** Gateway events: READY gives the application id, GUILD_CREATE registers the commands, INTERACTION_CREATE runs a handler. Returns at once. */
  dispatch(type: string, d: unknown): void {
    const x = d as { application?: { id?: string }; id?: string };
    if (type === "READY") this.#appId = x.application?.id ?? this.#appId;
    else if (type === "GUILD_CREATE" && typeof x.id === "string") void this.registerGuild(x.id);
    else if (type === "INTERACTION_CREATE") void this.#run(d as Interaction);
  }

  /** Makes the guild's commands exactly the registered definitions. Does nothing when this process already sent the same set. */
  async registerGuild(guildId: string): Promise<void> {
    if (!this.#appId || !this.#defs.length) return;
    const body = JSON.stringify(this.#defs);
    const sum = createHash("sha256").update(body).digest("hex");
    if (this.#registered.get(guildId) === sum) return;
    // Recorded before the request, so a second GUILD_CREATE while it runs does not send the set again.
    this.#registered.set(guildId, sum);
    try {
      await this.#rest.overwriteGuildCommands(this.#appId, guildId, this.#defs);
    } catch (e) {
      this.#registered.delete(guildId);
      this.#log(`discord: registering commands failed: ${(e as Error).message}`);
    }
  }

  #entry(i: Interaction): Entry | undefined {
    if (i.type === COMPONENT) {
      const id = i.data?.custom_id ?? "";
      return this.#components.get(id.split(":")[0]!);
    }
    if (i.type !== COMMAND) return undefined;
    const sub = i.data?.options?.find((o) => o.type === 1);
    return this.#commands.get(sub ? `${i.data?.name} ${sub.name}` : (i.data?.name ?? ""));
  }

  async #run(i: Interaction): Promise<void> {
    const entry = this.#entry(i);
    if (!entry) return;
    const appId = i.application_id ?? this.#appId;
    try {
      // Deferred first: a handler's own work never counts against the 3 seconds.
      await this.#rest.interactionCallback(i.id, i.token, 5, { ephemeral: entry.ephemeral });
      if (!appId) throw new Error("no application id");
      const sub = i.data?.options?.find((o) => o.type === 1);
      const opts = sub?.options ?? i.data?.options ?? [];
      const call: Call = {
        interaction: i,
        userId: i.member?.user?.id ?? i.user?.id ?? null,
        option: (name) => { const v = opts.find((o) => o.name === name)?.value; return typeof v === "string" ? v : undefined; },
        targetText: () => (i.data?.type === MESSAGE_COMMAND && i.data.target_id ? i.data.resolved?.messages?.[i.data.target_id]?.content : undefined),
        edit: (body) => this.#rest.editInteractionResponse(appId, i.token, body),
      };
      try {
        await entry.handler(call);
      } catch (e) {
        this.#log(`discord: command failed: ${(e as Error).message}`);
        await call.edit({ content: "Something went wrong. Try again in a moment." }).catch(() => undefined);
      }
    } catch (e) {
      this.#log(`discord: answering an interaction failed: ${(e as Error).message}`);
    }
  }
}
