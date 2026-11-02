// A refusal with a status code; the server renders it as a page, or as JSON
// under /api/.
export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// Minimal page for the server's own responses (sign-in, errors). Pages use
// their own layout.
export function plainPage(nonce: string, title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style nonce="${nonce}">
:root{color-scheme:light dark;--bg:#fff;--fg:#1a1a1a;--muted:#666;--link:#0b5cad}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#e8e8e8;--muted:#aaa;--link:#7ab4f5}}
body{background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif;margin:0;padding:2rem 16px;max-width:36rem}
a{color:var(--link)}p.muted{color:var(--muted)}
input,button{font:inherit;min-height:44px;padding:0 12px}
</style></head><body><h1>${esc(title)}</h1>${body}</body></html>`;
}

// Fixed-window counters, in memory: limits reset with the process, which is
// enough to slow down a loop or a stuck client.
export class RateLimiter {
  #hits = new Map<string, { start: number; n: number }>();
  #limit: number;
  #window: number;
  constructor(limit: number, windowMs: number) {
    this.#limit = limit;
    this.#window = windowMs;
  }
  allow(key: string): boolean {
    const now = Date.now();
    if (this.#hits.size > 10_000) {
      for (const [k, v] of this.#hits) if (now - v.start >= this.#window) this.#hits.delete(k);
    }
    const h = this.#hits.get(key);
    if (!h || now - h.start >= this.#window) {
      this.#hits.set(key, { start: now, n: 1 });
      return true;
    }
    return ++h.n <= this.#limit;
  }
}

export function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return out;
}

// Same-site paths only: "/x", never "//host" or "/\host".
export function safeReturnTo(v: string | null | undefined): string {
  return v && v.startsWith("/") && !v.startsWith("//") && !v.startsWith("/\\") && v.length < 2000 ? v : "/";
}
