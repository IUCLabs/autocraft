// The strict reader for a model reply that must be one JSON value. Gates read verdicts from replies that quote
// contributor text, so a reply is accepted only when it holds exactly one JSON value (an optional code fence and
// brace-free prose around it are fine) and no object repeats a key.

class Bad extends Error {}

function skipWs(s: string, i: number): number {
  while (i < s.length && " \t\n\r".includes(s[i]!)) i++;
  return i;
}

function parseString(s: string, i: number): number {
  let j = i + 1;
  while (j < s.length) {
    const c = s[j]!;
    if (c === "\\") { j += 2; continue; }
    if (c === '"') return j + 1;
    j++;
  }
  throw new Bad();
}

/** Parses the value at `i`; returns [value, end]. Objects with a repeated key are refused. */
function parseValue(s: string, i: number, depth: number): [unknown, number] {
  if (depth > 40) throw new Bad();
  i = skipWs(s, i);
  const c = s[i];
  if (c === "{") {
    const o: Record<string, unknown> = {};
    const seen = new Set<string>();
    i = skipWs(s, i + 1);
    if (s[i] === "}") return [o, i + 1];
    for (;;) {
      i = skipWs(s, i);
      if (s[i] !== '"') throw new Bad();
      const e = parseString(s, i);
      const key = JSON.parse(s.slice(i, e)) as string;
      if (seen.has(key)) throw new Bad();
      seen.add(key);
      i = skipWs(s, e);
      if (s[i] !== ":") throw new Bad();
      const [v, n] = parseValue(s, i + 1, depth + 1);
      Object.defineProperty(o, key, { value: v, enumerable: true, writable: true, configurable: true });
      i = skipWs(s, n);
      if (s[i] === ",") { i++; continue; }
      if (s[i] === "}") return [o, i + 1];
      throw new Bad();
    }
  }
  if (c === "[") {
    const a: unknown[] = [];
    i = skipWs(s, i + 1);
    if (s[i] === "]") return [a, i + 1];
    for (;;) {
      const [v, n] = parseValue(s, i, depth + 1);
      a.push(v);
      i = skipWs(s, n);
      if (s[i] === ",") { i++; continue; }
      if (s[i] === "]") return [a, i + 1];
      throw new Bad();
    }
  }
  if (c === '"') { const e = parseString(s, i); return [JSON.parse(s.slice(i, e)), e]; }
  const m = /^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(s.slice(i, i + 40));
  if (!m) throw new Bad();
  return [JSON.parse(m[0]), i + m[0].length];
}

/**
 * The one JSON value of a reply, or null. Text before and after it may not contain "{" or "[" (a fence line or a
 * sentence is fine; a quoted object is not), and no object may repeat a key.
 */
export function wholeReplyJson(text: string): unknown {
  const a = text.search(/[{[]/);
  if (a < 0) return null;
  try {
    const [v, end] = parseValue(text, a, 0);
    return /[{[]/.test(text.slice(end)) ? null : v;
  } catch { return null; }
}
