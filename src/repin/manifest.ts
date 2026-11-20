// The text side of autorepin (src/repin/index.ts): the pull request a command names, the `rev` of a Cargo manifest's git
// dependencies moved to a commit, and what a lockfile written for that move may change. Pure.
import { parseToml, type TomlTable } from "../core/toml.ts";

/** A pull request as a command names it: `owner/name#12`, `name#12` (owner null: whichever owner the tracked repo has) or its GitHub URL. */
export type PrRef = { owner: string | null; name: string; number: number };

const NAME = "[A-Za-z0-9][A-Za-z0-9._-]{0,99}";
const OWNER = "[A-Za-z0-9][A-Za-z0-9-]{0,38}";
const REF = new RegExp(`^(?:(?:(${OWNER})/)?(${NAME})#(\\d{1,9})|https://github\\.com/(${OWNER})/(${NAME})/pull/(\\d{1,9})/?)$`);

export function parsePrRef(s: string): PrRef | null {
  const m = REF.exec(s);
  if (!m) return null;
  const number = Number(m[3] ?? m[6]);
  return number > 0 ? { owner: m[1] ?? m[4] ?? null, name: (m[2] ?? m[5])!, number } : null;
}

const isTable = (v: unknown): v is TomlTable => !!v && typeof v === "object" && !Array.isArray(v);
const SHA = /^[0-9a-f]{40}$/;

/** `owner/name` (lowercase) of a GitHub repository URL as a manifest or a lockfile writes it, or null for any other source. */
export function githubSlug(url: string): string | null {
  const m = /^(?:git\+)?(?:https:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/?#]+)\/([^/?#]+?)(?:\.git)?\/?(?:[?#].*)?$/i.exec(url.trim());
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

/** Every table of the manifest with a `git` source on `slug`: dependencies of every kind, workspace dependencies and `[patch]` entries. */
function sourcesOn(data: unknown, slug: string, out: TomlTable[] = []): TomlTable[] {
  if (Array.isArray(data)) for (const x of data) sourcesOn(x, slug, out);
  else if (isTable(data)) {
    if (typeof data["git"] === "string" && githubSlug(data["git"]) === slug.toLowerCase()) out.push(data);
    for (const v of Object.values(data)) sourcesOn(v, slug, out);
  }
  return out;
}

export type Repinned =
  /** `text`: the manifest with every `rev` on the repository set to the commit. `from`: the revs it replaced (none: nothing to change). `unpinned`: sources on the repository without a `rev` (a branch, a tag or the default branch), left as they are. */
  | { ok: true; text: string; from: string[]; pinned: number; unpinned: number }
  | { ok: false; reason: string };

/**
 * The manifest with the `rev` of every git source on `slug` (`owner/name`) set to `sha`. Only the rev strings change: the
 * rewritten text must parse to the same manifest with exactly those values replaced, or it is refused.
 */
export function repinManifest(text: string, slug: string, sha: string): Repinned {
  if (!SHA.test(sha)) return { ok: false, reason: "the commit is not a full commit id" };
  const before = parseToml(text);
  if (!before.ok) return { ok: false, reason: `the manifest does not parse: ${before.error}` };
  const sources = sourcesOn(before.data, slug);
  const revs = sources.flatMap((t) => (typeof t["rev"] === "string" ? [t["rev"]] : []));
  const unpinned = sources.filter((t) => t["rev"] === undefined).length;
  if (sources.some((t) => t["rev"] !== undefined && typeof t["rev"] !== "string")) return { ok: false, reason: "a rev of the manifest is not a string" };
  const from = [...new Set(revs.filter((r) => r !== sha))];
  if (!from.length) return { ok: true, text, from, pinned: revs.length, unpinned };
  if (from.some((r) => !/^[0-9a-fA-F]{7,64}$/.test(r))) return { ok: false, reason: "a rev of the manifest is not a commit id" };
  let out = text;
  for (const r of from) out = out.replace(new RegExp(`(\\brev\\s*=\\s*)(["'])${r}\\2`, "g"), `$1"${sha}"`);
  // What the edit must amount to: the same manifest with those revs replaced, and nothing else.
  for (const t of sources) if (typeof t["rev"] === "string") t["rev"] = sha;
  const after = parseToml(out);
  if (!after.ok || JSON.stringify(after.data) !== JSON.stringify(before.data)) return { ok: false, reason: "the rev could not be rewritten without changing something else in the manifest" };
  return { ok: true, text: out, from, pinned: revs.length, unpinned };
}

type Locked = { name: string; version: string; source: string | null; checksum: string | null };

/** The packages of a Cargo.lock; null when a `[[package]]` has no name or version. */
function lockedPackages(text: string): Locked[] | null {
  const out: Locked[] = [];
  let cur: Partial<Locked> | null = null;
  const close = (): boolean => {
    if (!cur) return true;
    if (cur.name === undefined || cur.version === undefined) return false;
    out.push({ name: cur.name, version: cur.version, source: cur.source ?? null, checksum: cur.checksum ?? null });
    cur = null;
    return true;
  };
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim();
    if (l.startsWith("[")) {
      if (!close()) return null;
      if (l === "[[package]]") cur = {};
      continue;
    }
    if (!cur) continue;
    const m = /^(name|version|source|checksum) = "([^"\\]*)"$/.exec(l);
    if (m) (cur as Record<string, string>)[m[1]!] = m[2]!;
  }
  return close() ? out : null;
}

const CRATES_IO = new Set(["registry+https://github.com/rust-lang/crates.io-index", "sparse+https://index.crates.io/"]);

/**
 * Why the lockfile `after`, written by Cargo for the repinned manifests, is not accepted in place of `before`, or null.
 * It may add packages from crates.io and from `slug` at `sha`, and drop packages. It may not name another new source,
 * keep a package of `slug` at another commit, or change the checksum of a package it keeps.
 */
export function lockRefusal(before: string, after: string, slug: string, sha: string): string | null {
  const was = lockedPackages(before), now = lockedPackages(after);
  if (!was || !now) return "the lockfile does not read as a Cargo.lock";
  if (!now.length) return "the new lockfile lists no packages";
  const key = (p: Locked): string => `${p.name}@${p.version}@${p.source ?? ""}`;
  const known = new Map(was.map((p) => [key(p), p]));
  const want = slug.toLowerCase();
  for (const p of now) {
    const repo = p.source === null ? null : githubSlug(p.source.split("?")[0]!.split("#")[0]!);
    if (p.source !== null && p.source.startsWith("git+") && repo === want) {
      // Cargo writes `git+<url>?rev=<rev of the manifest>#<the commit it resolved to>`.
      if (!p.source.endsWith(`?rev=${sha}#${sha}`)) return `the new lockfile has ${p.name} from ${slug} at another commit`;
      continue;
    }
    const old = known.get(key(p));
    if (!old) {
      if (p.source === null) return `the new lockfile adds the local package ${p.name}`;
      if (!CRATES_IO.has(p.source)) return `the new lockfile adds ${p.name} from a source outside crates.io and ${slug}`;
    } else if (old.checksum !== p.checksum) return `the new lockfile changes the checksum of ${p.name} ${p.version}`;
  }
  return null;
}
