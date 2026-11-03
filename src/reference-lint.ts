// Checks of public-facing model text against the repo's private reference documentation: a verbatim check
// (12 consecutive words that appear in the reference pages) and a semantic one (does the text refer to
// documentation or a vendor of another product: Jev first, Haiku for the unsure and while Jev is unavailable).
// Both only run for a repo that has a reference folder.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { jevAvailable } from "./agents/jev.ts";
import { askClaude, askJev } from "./classify/run.ts";
import { CLAUDE_PROMPTS, renderReferenceJev } from "./prompts/index.ts";
import { QUOTE_WORDS, REFERENCE_JEV_ACCEPT, REFERENCE_JEV_REJECT, type LintProblem } from "./replylint.ts";
import { REFERENCE_LEAK } from "./review/opus-parse.ts";

const tokens = (s: string): string[] => s.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];

/** A 52-bit hash of a window of words: a false match needs a collision among a few million entries, about 1 in 10^9 per window. */
function windowHash(words: string[], at: number): number {
  let h1 = 0x811c9dc5, h2 = 0x1b873593;
  for (let i = at; i < at + QUOTE_WORDS; i++) {
    const w = words[i]!;
    for (let k = 0; k < w.length; k++) {
      const c = w.charCodeAt(k);
      h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
      h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
      h2 ^= h2 >>> 13;
    }
    h1 = Math.imul(h1 ^ 32, 16777619) >>> 0;
    h2 = Math.imul(h2 ^ 32, 0x85ebca6b) >>> 0;
  }
  return (h1 & 0xfffff) * 4294967296 + h2;
}

function textFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...textFiles(p));
    else if (e.isFile() && /\.(txt|md)$/.test(e.name)) out.push(p);
  }
  return out;
}

const cache = new Map<string, { stamp: string; hashes: Float64Array }>();

/** Sorted window hashes of every page text of a reference folder, built once per process and rebuilt when the folder's mtime changes. */
function windows(dir: string): Float64Array {
  const st = statSync(dir), stamp = `${st.mtimeMs}:${st.ino}`;
  const hit = cache.get(dir);
  if (hit?.stamp === stamp) return hit.hashes;
  let all = new Float64Array(1 << 16), n = 0;
  for (const f of textFiles(dir)) {
    const w = tokens(readFileSync(f, "utf8"));
    for (let i = 0; i + QUOTE_WORDS <= w.length; i++) {
      if (n === all.length) { const g = new Float64Array(all.length * 2); g.set(all); all = g; }
      all[n++] = windowHash(w, i);
    }
  }
  const hashes = all.slice(0, n).sort();
  cache.set(dir, { stamp, hashes });
  return hashes;
}

function has(sorted: Float64Array, x: number): boolean {
  let lo = 0, hi = sorted.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1, v = sorted[mid]!;
    if (v === x) return true;
    if (v < x) lo = mid + 1; else hi = mid - 1;
  }
  return false;
}

/** True when `text` holds a run of 12 or more consecutive words (case and whitespace ignored) that appears in the reference pages of `dir`. */
export function quotesReference(text: string, dir: string): boolean {
  const w = tokens(text);
  if (w.length < QUOTE_WORDS) return false;
  const set = windows(dir);
  if (!set.length) return false;
  for (let i = 0; i + QUOTE_WORDS <= w.length; i++) if (has(set, windowHash(w, i))) return true;
  return false;
}

export type SemanticDeps = {
  /** Jev's yes-probability that the text refers to outside documentation or a vendor; null when it gave no valid answer. */
  jev(text: string): Promise<number | null>;
  /** Haiku's verdict (true: it refers); null when it gave no valid answer. */
  haiku(text: string): Promise<boolean | null>;
  /** False while Jev is unavailable: Haiku then decides alone. Absent means available. */
  jevUsable?(): boolean;
};

export function defaultSemanticDeps(db: DatabaseSync, ref: string): SemanticDeps {
  const HAIKU = CLAUDE_PROMPTS["lint.reference.haiku"];
  return {
    async jev(text) {
      for (let attempt = 0; attempt < 2 && jevAvailable(db); attempt++) {
        const r = await askJev("lint.reference.jev", { ref }, db, renderReferenceJev(text));
        try {
          const p = (JSON.parse(r.stdout) as { answers?: { refers?: { noul?: unknown } } }).answers?.refers?.noul;
          if (typeof p === "number" && p >= 0 && p <= 1) return p;
        } catch { /* retry once */ }
      }
      return null;
    },
    async haiku(text) {
      for (let attempt = 0; attempt < HAIKU.limits.attempts; attempt++) {
        const reply = await askClaude("lint.reference.haiku", HAIKU.models[0]!, [{ ref, text }], db);
        if (!reply) continue;
        const a = reply.text.indexOf("["), b = reply.text.lastIndexOf("]");
        try {
          const o = (JSON.parse(reply.text.slice(a, b + 1)) as { ref?: unknown; refers?: unknown }[])[0];
          if (o && o.ref === ref && typeof o.refers === "boolean") return o.refers;
        } catch { /* retry once */ }
      }
      return null;
    },
    jevUsable: () => jevAvailable(db),
  };
}

/** Whether the text refers to outside documentation or a vendor: Jev at 0.9 or more says yes and below 0.3 no; Haiku decides the rest and everything while Jev is unavailable. An unanswered check counts as no. */
export async function refersToDocumentation(text: string, deps: SemanticDeps): Promise<boolean> {
  const p = (deps.jevUsable?.() ?? true) ? await deps.jev(text) : null;
  if (p !== null && p >= REFERENCE_JEV_ACCEPT) return true;
  if (p !== null && p < REFERENCE_JEV_REJECT) return false;
  return (await deps.haiku(text)) === true;
}

export type PublicText = { field: string; text: string };

/**
 * Problems of public-facing texts: a mention of the reference folder or a page file, a verbatim quote of the reference
 * pages, and (when `semantic` is given) a reference to outside documentation. Only for a repo with a reference folder `dir`.
 */
export async function referenceProblems(texts: PublicText[], dir: string | undefined, semantic?: SemanticDeps): Promise<LintProblem[]> {
  const out: LintProblem[] = [];
  for (const t of texts) {
    if (REFERENCE_LEAK.test(t.text)) out.push({ field: t.field, message: "mentions the reference folder or one of its pages; state the behaviour in your own words", text: t.text });
    else if (dir && quotesReference(t.text, dir)) out.push({ field: t.field, message: "quotes the reference documentation; state the behaviour in your own words", text: t.text });
    else if (dir && semantic && await refersToDocumentation(t.text, semantic)) out.push({ field: t.field, message: "refers to outside documentation; state the behaviour in your own words", text: t.text });
  }
  return out;
}
