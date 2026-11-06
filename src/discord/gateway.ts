// Minimal Discord gateway client on Node's WebSocket and fetch. It identifies with the GUILDS, GUILD_MESSAGES and
// MESSAGE_CONTENT intents, heartbeats, resumes or reconnects with backoff, and passes only guild, channel and message
// events on. It never reads message history and never sends a message.
const API = "https://discord.com/api/v10";
export const INTENTS = (1 << 0) | (1 << 9) | (1 << 15);

/** Close codes after which reconnecting cannot help (bad token, intents not allowed, bad shard or version). */
const FATAL = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

export type Socket = {
  send(data: string): void;
  close(code?: number): void;
  onopen: (() => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: ((e: { code: number }) => void) | null;
  onerror: (() => void) | null;
};

export type GatewayDeps = {
  token: string;
  /** Called for every dispatch: READY, GUILD_CREATE, CHANNEL_*, MESSAGE_* and GUILD_DELETE. */
  onDispatch: (type: string, data: unknown) => void;
  onState: (state: "connecting" | "connected" | "reconnecting" | "failed", detail: string | null) => void;
  log: (line: string) => void;
  fetch?: typeof fetch;
  open?: (url: string) => Socket;
  now?: () => number;
  random?: () => number;
};

const wait = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done(): void {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });

export class Gateway {
  #d: GatewayDeps;
  #seq: number | null = null;
  #session: string | null = null;
  #resumeUrl: string | null = null;
  #lastIdentify = 0;

  constructor(deps: GatewayDeps) {
    this.#d = deps;
  }

  /** Runs until `signal` aborts or Discord refuses the connection for good. Never throws. */
  async run(signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      this.#d.onState(failures ? "reconnecting" : "connecting", null);
      let fatal = false;
      try {
        const connectedFor = await this.#connectOnce(signal);
        if (connectedFor.fatal) fatal = true;
        failures = connectedFor.ok ? 0 : failures + 1;
      } catch (e) {
        failures++;
        this.#d.log(`discord: ${(e as Error).message}`);
      }
      if (fatal) return;
      if (signal.aborted) break;
      const rnd = (this.#d.random ?? Math.random)();
      await wait(Math.min(300_000, 1000 * 2 ** Math.min(failures, 8)) * (0.5 + rnd / 2), signal);
    }
  }

  async #gatewayUrl(signal: AbortSignal): Promise<string> {
    if (this.#session && this.#resumeUrl) return this.#resumeUrl;
    const f = this.#d.fetch ?? fetch;
    for (let attempt = 0; attempt < 5; attempt++) {
      const r = await f(`${API}/gateway/bot`, { headers: { authorization: `Bot ${this.#d.token}` }, signal });
      if (r.status === 429) {
        const body = (await r.json().catch(() => ({}))) as { retry_after?: number };
        await wait(Math.min(60, Math.max(1, body.retry_after ?? 5)) * 1000, signal);
        continue;
      }
      if (r.status === 401) throw new FatalError("Discord rejected the bot token");
      if (!r.ok) throw new Error(`gateway lookup failed: HTTP ${r.status}`);
      return `${((await r.json()) as { url: string }).url}/?v=10&encoding=json`;
    }
    throw new Error("gateway lookup is rate limited");
  }

  async #connectOnce(signal: AbortSignal): Promise<{ ok: boolean; fatal: boolean }> {
    let url: string;
    try {
      url = await this.#gatewayUrl(signal);
    } catch (e) {
      if (e instanceof FatalError) {
        this.#d.onState("failed", e.message);
        this.#d.log(`discord: ${e.message}; not reconnecting`);
        return { ok: false, fatal: true };
      }
      throw e;
    }
    if (signal.aborted) return { ok: true, fatal: false };
    const sock = (this.#d.open ?? ((u) => new WebSocket(u) as unknown as Socket))(url);
    return new Promise((resolve) => {
      let hb: ReturnType<typeof setInterval> | undefined;
      let first: ReturnType<typeof setTimeout> | undefined;
      let acked = true;
      let ready = false;
      const stop = (): void => {
        clearInterval(hb);
        clearTimeout(first);
        signal.removeEventListener("abort", onAbort);
      };
      const onAbort = (): void => {
        try { sock.close(1000); } catch { /* already closed */ }
      };
      signal.addEventListener("abort", onAbort, { once: true });
      const send = (op: number, d: unknown): void => sock.send(JSON.stringify({ op, d }));
      const beat = (): void => {
        if (!acked) {
          // No acknowledgement for the last heartbeat: the connection is dead. 4000 keeps the session resumable.
          this.#d.log("discord: heartbeat not acknowledged; reconnecting");
          try { sock.close(4000); } catch { /* ignore */ }
          return;
        }
        acked = false;
        send(1, this.#seq);
      };
      sock.onmessage = (e) => {
        let p: { op: number; d: unknown; s: number | null; t: string | null };
        try {
          p = JSON.parse(String(e.data));
        } catch {
          return;
        }
        if (p.s !== null && p.s !== undefined) this.#seq = p.s;
        if (p.op === 10) {
          const every = (p.d as { heartbeat_interval: number }).heartbeat_interval;
          first = setTimeout(() => { beat(); hb = setInterval(beat, every); }, every * (this.#d.random ?? Math.random)());
          void this.#identify(send, signal);
        } else if (p.op === 11) {
          acked = true;
        } else if (p.op === 1) {
          send(1, this.#seq);
        } else if (p.op === 7) {
          try { sock.close(4000); } catch { /* ignore */ }
        } else if (p.op === 9) {
          // Invalid session: d tells whether it can be resumed.
          if (p.d !== true) { this.#session = null; this.#resumeUrl = null; this.#seq = null; }
          try { sock.close(4000); } catch { /* ignore */ }
        } else if (p.op === 0 && p.t) {
          if (p.t === "READY") {
            const r = p.d as { session_id: string; resume_gateway_url: string };
            this.#session = r.session_id;
            this.#resumeUrl = `${r.resume_gateway_url}/?v=10&encoding=json`;
            ready = true;
            this.#d.onState("connected", null);
          } else if (p.t === "RESUMED") {
            ready = true;
            this.#d.onState("connected", null);
          }
          try {
            this.#d.onDispatch(p.t, p.d);
          } catch (err) {
            this.#d.log(`discord: handling ${p.t} failed: ${(err as Error).message}`);
          }
        }
      };
      sock.onerror = () => this.#d.log("discord: socket error");
      sock.onclose = (e) => {
        stop();
        if (FATAL.has(e.code)) {
          this.#d.onState("failed", `Discord closed the connection with code ${e.code}${e.code === 4014 ? " (enable the Message Content intent for the bot)" : ""}`);
          this.#d.log(`discord: closed with code ${e.code}; not reconnecting`);
          return resolve({ ok: false, fatal: true });
        }
        // 4007 (bad sequence) and 4009 (session timed out) mean the session is gone.
        if (e.code === 4007 || e.code === 4009) { this.#session = null; this.#resumeUrl = null; this.#seq = null; }
        resolve({ ok: ready, fatal: false });
      };
    });
  }

  /** Identify, or resume a session. Identifies are at least 6 s apart (Discord allows one per 5 s). */
  async #identify(send: (op: number, d: unknown) => void, signal: AbortSignal): Promise<void> {
    if (this.#session && this.#seq !== null) {
      send(6, { token: this.#d.token, session_id: this.#session, seq: this.#seq });
      return;
    }
    const now = (this.#d.now ?? Date.now)();
    const gap = this.#lastIdentify + 6000 - now;
    if (gap > 0) await wait(gap, signal);
    this.#lastIdentify = (this.#d.now ?? Date.now)();
    send(2, { token: this.#d.token, intents: INTENTS, properties: { os: "linux", browser: "autocraft", device: "autocraft" } });
  }
}

class FatalError extends Error {}
