import { homedir } from "node:os";

// Replaces anything that looks like a credential. Logs hold step output only,
// but a tool's error message could still quote a header or an environment value.
const SECRET_PATTERNS: RegExp[] = [
  /\b(gh[pousr]_[A-Za-z0-9]{20,})/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\b(Bearer|token|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /\b([A-Za-z_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|SESSION_KEY|CLIENT_SECRET)[A-Za-z_]*)\s*[:=]\s*("[^"]*"|'[^']*'|\S+)/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
];
// Long mixed-case letter-and-digit runs (keys) that aren't hex digests or commit ids.
const LONG_RANDOM = /\b[A-Za-z0-9_+/-]{40,}={0,2}/g;
// Credentials in a URL: scheme://user:password@host.
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@:]+:[^\s/?#@]+@/gi;
// A hex value given under a key-like name, also quoted as in JSON (worker keys, webhook and session secrets).
const NAMED_HEX = /\b([A-Za-z_-]*(?:secret|token|passw|hmac|cookie|credential|authorization|(?:api|access|private|signing|session|worker|client)[_-]?key)[A-Za-z_-]*["']?\s*[:=]\s*["']?)[0-9a-f]{16,}\b/gi;
// Three dot-separated base64url parts: JWTs and other signed tokens (a Discord bot token has a short middle part).
const DOTTED = /\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{16,}\b/g;
const HEX_RUN = /\b[0-9a-f]{32,}\b/gi;
const B64_RUN = /[A-Za-z0-9+/_-]{20,}={0,2}/g;
// Hex lengths of md5, sha1 (commit ids), sha224, sha256, sha384 and sha512 digests: any other long hex run is taken for a key.
const DIGEST_LENGTHS = new Set([32, 40, 56, 64, 96, 128]);
const mixed = (m: string) => /[A-Z]/.test(m) && /[a-z]/.test(m) && /[0-9]/.test(m);
const matches = (re: RegExp, text: string) => { re.lastIndex = 0; return re.test(text); };

// A known credential shape inside a hex or base64 encoding (a Basic header value without its label, an encoded environment).
function decodesToSecret(m: string, encoding: "hex" | "base64"): boolean {
  if (encoding === "hex" && m.length % 2) return false;
  const d = Buffer.from(encoding === "hex" ? m : m.replace(/-/g, "+").replace(/_/g, "/"), encoding).toString("latin1");
  return /^[\x20-\x7e\t\n\r]+$/.test(d) && [...SECRET_PATTERNS, URL_USERINFO].some((p) => matches(p, d));
}

/** Hides anything that looks like a credential: for logs, stored copies and text that is shown or posted. */
export function scrub(text: string): string {
  // Encoded credentials first, while the encoded run is still whole.
  let t = text.replace(B64_RUN, (m) => (/^[0-9a-f]+$/i.test(m) || !decodesToSecret(m, "base64") ? m : "[hidden]"));
  t = t.replace(HEX_RUN, (m) => (/^[0-9]+$/.test(m) || (DIGEST_LENGTHS.has(m.length) && !decodesToSecret(m, "hex")) ? m : "[hidden]"));
  t = t.replace(URL_USERINFO, "$1[hidden]@");
  t = t.replace(NAMED_HEX, "$1[hidden]");
  t = t.replace(DOTTED, (m) => (mixed(m) ? "[hidden]" : m));
  return scrubCredentials(t);
}

/**
 * Hides only the known credential shapes (provider token prefixes, keys, auth headers, named values, long mixed random
 * runs). A model reply that carries code is read through this one: hex literals, URLs with user info and dotted names
 * in code stay as written, and `scrub` covers the stored copy.
 */
export function scrubCredentials(text: string): string {
  // Paths under the home directory show as ~/...: the log is shown to everyone signed in.
  let t = text.replaceAll(homedir(), "~");
  for (const p of SECRET_PATTERNS) {
    t = t.replace(p, (m, name?: string) => {
      if (/^(Bearer|token|Basic)$/i.test(name ?? "")) return `${name} [hidden]`;
      return typeof name === "string" && name !== m && /^[A-Za-z_]+$/.test(name) && /[=:]/.test(m) ? `${name}=[hidden]` : "[hidden]";
    });
  }
  return t.replace(LONG_RANDOM, (m) => (/^[0-9a-f]+$/i.test(m) || !mixed(m) ? m : "[hidden]"));
}
