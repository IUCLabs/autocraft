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

export function scrub(text: string): string {
  // Paths under the home directory show as ~/...: the log is shown to everyone signed in.
  let t = text.replaceAll(homedir(), "~");
  for (const p of SECRET_PATTERNS) {
    t = t.replace(p, (m, name?: string) => {
      if (/^(Bearer|token|Basic)$/i.test(name ?? "")) return `${name} [hidden]`;
      return typeof name === "string" && name !== m && /^[A-Za-z_]+$/.test(name) && /[=:]/.test(m) ? `${name}=[hidden]` : "[hidden]";
    });
  }
  return t.replace(LONG_RANDOM, (m) => (/^[0-9a-f]+$/i.test(m) || !/[A-Z]/.test(m) || !/[a-z]/.test(m) || !/[0-9]/.test(m) ? m : "[hidden]"));
}
