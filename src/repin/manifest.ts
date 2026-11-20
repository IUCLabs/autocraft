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

const DEP_TABLES = ["dependencies", "dev-dependencies", "dev_dependencies", "build-dependencies", "build_dependencies"];

/**
 * Every dependency of the manifest with a `git` source on `slug`: the dependency tables of the package, of each target and of
 * the workspace, and the `[patch]` entries. No other table counts (`[package.metadata]` may hold a `git` and a `rev` of its own).
 */
function sourcesOn(data: TomlTable, slug: string): TomlTable[] {
  const tables: unknown[] = DEP_TABLES.map((t) => data[t]);
  if (isTable(data["workspace"])) tables.push(data["workspace"]["dependencies"]);
  if (isTable(data["target"])) for (const t of Object.values(data["target"])) if (isTable(t)) tables.push(...DEP_TABLES.map((d) => t[d]));
  if (isTable(data["patch"])) tables.push(...Object.values(data["patch"]));
  const out: TomlTable[] = [];
  for (const deps of tables) {
    if (!isTable(deps)) continue;
    for (const spec of Object.values(deps)) if (isTable(spec) && typeof spec["git"] === "string" && githubSlug(spec["git"]) === slug.toLowerCase()) out.push(spec);
  }
  return out;
}

export type Repinned =
  /** `text`: the manifest with every `rev` on the repository set to the commit. `from`: the revs it replaced (none: nothing to change). `unpinned`: sources on the repository without a `rev` (a branch, a tag or the default branch), left as they are. */
  | { ok: true; text: string; from: string[]; pinned: number; unpinned: number }
  /** `reason` is worded here, safe to post; `detail` (the parser's message) is for the log only. */
  | { ok: false; reason: string; detail?: string };

/**
 * The manifest with the `rev` of every git source on `slug` (`owner/name`) set to `sha`. Only the rev strings change: the
 * rewritten text must parse to the same manifest with exactly those values replaced, or it is refused.
 */
export function repinManifest(text: string, slug: string, sha: string): Repinned {
  if (!SHA.test(sha)) return { ok: false, reason: "the commit is not a full commit id" };
  const before = parseToml(text);
  if (!before.ok) return { ok: false, reason: "the manifest does not parse as TOML", detail: before.error };
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

/** The packages of a Cargo.lock, read as TOML; null when it does not parse or a package's name, version, source or checksum is not what Cargo writes. */
function lockedPackages(text: string): Locked[] | null {
  const r = parseToml(text);
  if (!r.ok) return null;
  const list = r.data["package"] ?? [];
  if (!Array.isArray(list)) return null;
  const out: Locked[] = [];
  for (const p of list) {
    if (!isTable(p) || typeof p["name"] !== "string" || typeof p["version"] !== "string") return null;
    const source = p["source"] ?? null, checksum = p["checksum"] ?? null;
    if ((source !== null && typeof source !== "string") || (checksum !== null && typeof checksum !== "string")) return null;
    out.push({ name: p["name"], version: p["version"], source, checksum });
  }
  return out;
}

const CRATES_IO = new Set(["registry+https://github.com/rust-lang/crates.io-index", "sparse+https://index.crates.io/"]);

/** A package name as Cargo writes it, else a neutral word, so a reason never repeats arbitrary file text. */
export const safeName = (s: string): string => (/^[A-Za-z0-9_-]{1,64}$/.test(s) ? s : "a package");
/** A repository path of plain characters, else a neutral word. */
export const safePath = (s: string, what: string): string => (/^[A-Za-z0-9._/-]{1,200}$/.test(s) ? s : what);

/**
 * Why the lockfile `after`, written by Cargo for the repinned manifests, is not accepted in place of `before`, or null.
 * Every package of `slug` must be at `sha`, pinned by rev. Any other package must be in `before` with the same name, source,
 * version and checksum, except a crates.io package whose name `before` has from no source at all: Cargo may add those for the
 * dependency's new requirements. Packages may be dropped.
 */
export function lockRefusal(before: string, after: string, slug: string, sha: string): string | null {
  const was = lockedPackages(before), now = lockedPackages(after);
  if (!was || !now) return "the lockfile does not read as a Cargo.lock";
  if (!now.length) return "the new lockfile lists no packages";
  const exact = (p: Locked): string => `${p.name}\0${p.source ?? ""}\0${p.version}\0${p.checksum ?? ""}`;
  const kept = new Set(was.map(exact));
  // Names the old lockfile has from crates.io (either index's spelling) or from any other source but a local path.
  const known = new Set(was.filter((p) => p.source !== null).map((p) => p.name));
  const want = slug.toLowerCase();
  for (const p of now) {
    const name = safeName(p.name);
    const repo = p.source === null ? null : githubSlug(p.source.split("?")[0]!.split("#")[0]!);
    if (p.source !== null && p.source.startsWith("git+") && repo === want) {
      // Cargo writes `git+<url>?rev=<rev of the manifest>#<the commit it resolved to>`.
      if (p.source.endsWith(`?rev=${sha}#${sha}`)) continue;
      if (!/\?rev=/.test(p.source)) return `the new lockfile has ${name} from ${slug} by branch, tag or default branch; autorepin moves only revs, so pin it by rev to use autorepin`;
      return `the new lockfile has ${name} from ${slug} at another commit`;
    }
    if (kept.has(exact(p))) continue;
    if (p.source === null) return `the new lockfile adds or changes the local package ${name}`;
    if (!CRATES_IO.has(p.source)) return `the new lockfile adds ${name} from a source outside crates.io and ${slug}`;
    if (known.has(p.name)) return `the new lockfile changes the version, source or checksum of ${name}`;
  }
  return null;
}
