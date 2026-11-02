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

// Minimal page for the server's own responses (sign-in, sign-out, errors), in
// the dashboard's colours. The inline script applies the theme the reader chose
// in the dashboard (stored by web/src/shell/theme.ts); without it the page
// follows the system setting.
export function plainPage(nonce: string, title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<script nonce="${nonce}">try{var t=localStorage.getItem("craft-triage:theme");if(t==="dark"||t==="light")document.documentElement.dataset.theme=t}catch(e){}</script>
<style nonce="${nonce}">
:root{color-scheme:dark;--bg:#101014;--card:#141518;--fg:#f2f1ee;--muted:#9a9aa0;--line:rgba(255,255,255,.1);--link:#74aaff;--accent:#2d81ff}
@media (prefers-color-scheme:light){:root:not([data-theme=dark]){color-scheme:light;--bg:#f2f1ee;--card:#fbfaf8;--fg:#101014;--muted:#5f5f66;--line:rgba(16,16,20,.12);--link:#1454dc;--accent:#1b63f5}}
:root[data-theme=light]{color-scheme:light;--bg:#f2f1ee;--card:#fbfaf8;--fg:#101014;--muted:#5f5f66;--line:rgba(16,16,20,.12);--link:#1454dc;--accent:#1b63f5}
body{background:var(--bg);color:var(--fg);font:15px/1.5 Inter,system-ui,sans-serif;margin:0;min-height:100vh;display:flex;align-items:flex-start;justify-content:center;padding:12vh 16px 2rem;box-sizing:border-box}
main{width:100%;max-width:26rem;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:24px}
.brand{font-size:13px;font-weight:600;color:var(--muted);margin:0 0 12px}
h1{font-size:20px;line-height:1.3;margin:0 0 8px}
p{margin:8px 0}a{color:var(--link)}p.muted{color:var(--muted)}code{font-size:13px}
input,button,a.button{font:inherit;min-height:40px;padding:0 14px;border-radius:6px;box-sizing:border-box}
input{border:1px solid var(--line);background:var(--bg);color:var(--fg)}
button,a.button{display:inline-flex;align-items:center;border:0;background:var(--accent);color:#fff;text-decoration:none;font-weight:500;cursor:pointer}
</style></head><body><main><p class="brand">Craft Triage</p><h1>${esc(title)}</h1>${body}</main></body></html>`;
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
