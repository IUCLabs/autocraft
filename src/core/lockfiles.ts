// What in a lockfile change needs a person: a source outside the default registry, a new checksum for a version already
// locked, a lockfile that changes with no manifest change beside it, or one that is renamed, copied or deleted. A
// routine version update from the default registry needs nobody. Pure: it reads the sections of a unified diff.
import { isDeletedFile, isLockfile, type FileDiff } from "../review/diff.ts";

export const LOCK_SOURCE_REASON = "lockfile adds a source outside the default registry";
export const LOCK_CHECKSUM_REASON = "lockfile changes the checksum of a locked version";
export const LOCK_ALONE_REASON = "lockfile changes without a manifest change";
export const LOCK_MOVED_REASON = "renames, copies or deletes a lockfile";

type Format = {
  manifests: string[];
  /** A line that starts a locked package. `startKey`: the start line names the package (with its version when there is no `version`). */
  start: RegExp; startKey?: boolean;
  name?: RegExp; version?: RegExp;
  hash: RegExp;
  /** True for an added line that names a source outside the default registry. */
  foreign: (line: string) => boolean;
};

const TOML_RECORD = { start: /^\[\[package\]\]\s*$/, name: /^name = "([^"]+)"/, version: /^version = "([^"]+)"/ };
const NPM_REGISTRY = /^https:\/\/registry\.(npmjs\.org|yarnpkg\.com)\//;

const FORMATS: Record<string, Format> = {
  "cargo.lock": {
    manifests: ["cargo.toml"], ...TOML_RECORD, hash: /^checksum = "([^"]+)"/g,
    foreign: (l) => { const m = /^\s*source\s*=\s*"([^"]*)"/.exec(l); return !!m && m[1] !== "registry+https://github.com/rust-lang/crates.io-index" && m[1] !== "sparse+https://index.crates.io/"; },
  },
  "uv.lock": {
    manifests: ["pyproject.toml"], ...TOML_RECORD, hash: /hash = "([^"]+)"/g,
    foreign: (l) => [...l.matchAll(/source\s*=\s*\{\s*([\w-]+)\s*=\s*"([^"]*)"/g)].some((m) => !(m[1] === "registry" && m[2] === "https://pypi.org/simple")),
  },
  "poetry.lock": {
    manifests: ["pyproject.toml"], ...TOML_RECORD, hash: /hash = "([^"]+)"/g,
    foreign: (l) => /^\s*\[package\.source\]/.test(l),
  },
  "package-lock.json": {
    manifests: ["package.json"], start: /^\s*"([^"]*)": \{\s*$/, startKey: true, version: /^\s*"version": "([^"]+)"/, hash: /^\s*"integrity": "([^"]+)"/g,
    foreign: (l) => { const m = /"resolved": "([^"]*)"/.exec(l); return (!!m && !NPM_REGISTRY.test(m[1]!)) || /"link": true/.test(l); },
  },
  "yarn.lock": {
    manifests: ["package.json"], start: /^(?!#)(\S.*):\s*$/, startKey: true, version: /^\s+version:? "?([^"\s]+)"?/, hash: /^\s+(?:integrity|checksum):? "?([^"\s]+)"?/g,
    foreign: (l) => {
      const v1 = /^\s+resolved "([^"]*)"/.exec(l), berry = /^\s+resolution: "?([^"]*)"?/.exec(l);
      return (!!v1 && !NPM_REGISTRY.test(v1[1]!)) || (!!berry && !/@npm:/.test(berry[1]!));
    },
  },
  "pnpm-lock.yaml": {
    manifests: ["package.json", "pnpm-workspace.yaml"], start: /^\s{2}'?([^\s':][^\s']*)'?:\s*$/, startKey: true, hash: /integrity: ([^,}\s]+)/g,
    // A resolution other than a registry integrity, or a version that is a link, file, git or URL specifier.
    foreign: (l) => {
      const r = /resolution:\s*\{([^}]*)\}?/.exec(l);
      return (!!r && r[1]!.split(",").some((kv) => kv.trim() !== "" && !/^\s*integrity:/.test(kv))) || /:\s+'?(link|file|github|git(\+[a-z]+)?|https?):/.test(l);
    },
  },
  "go.sum": {
    manifests: ["go.mod"], start: /^(\S+ \S+) \S+$/, startKey: true, hash: /^\S+ \S+ (\S+)$/g,
    foreign: () => false,
  },
};

const base = (p: string) => p.split("/").pop()!.toLowerCase();

type Rec = { key: string | null; hashes: string[]; hashChanged: boolean };
type Line = { text: string; changed: boolean } | null;

/** The packages one side of a section shows: that side's hunk lines, each with whether it changed; null between hunks. */
function records(f: Format, lines: Line[]): Rec[] {
  const out: Rec[] = [];
  let cur: { name: string | null; version: string | null; hashes: string[]; hashChanged: boolean } | null = null;
  const close = () => {
    if (!cur) return;
    const complete = cur.name !== null && (!f.version || cur.version !== null);
    out.push({ key: complete ? `${cur.name}@${cur.version ?? ""}` : null, hashes: cur.hashes, hashChanged: cur.hashChanged });
    cur = null;
  };
  for (const l of lines) {
    if (!l) { close(); continue; }
    const s = f.start.exec(l.text);
    if (s) { close(); cur = { name: f.startKey ? s[1]! : null, version: null, hashes: [], hashChanged: false }; }
    // Lines before the first start belong to a package that begins above the hunk.
    cur ??= { name: null, version: null, hashes: [], hashChanged: false };
    const n = f.name?.exec(l.text);
    if (n && !f.startKey) cur.name = n[1]!;
    const v = f.version?.exec(l.text);
    if (v) cur.version = v[1]!;
    const hs = [...l.text.matchAll(f.hash)].map((m) => m[1]!);
    if (hs.length) { cur.hashes.push(...hs); if (l.changed) cur.hashChanged = true; }
  }
  close();
  return out;
}

/** The lockfile reasons of a diff's sections, in a fixed order. */
export function lockfileReasons(sections: FileDiff[]): string[] {
  const names = new Set(sections.flatMap((s) => [base(s.path), base(s.oldPath)]));
  let source = false, checksum = false, alone = false, moved = false;
  for (const s of sections) {
    if (!isLockfile(s.path) && !isLockfile(s.oldPath)) continue;
    if (s.path !== s.oldPath || isDeletedFile(s) || s.head.some((l) => /^(copy|rename) (from|to) /.test(l))) { moved = true; continue; }
    const f = FORMATS[base(s.path)];
    if (!f) { moved = true; continue; }
    if (!f.manifests.some((m) => names.has(m))) alone = true;
    const before: Line[] = [], after: Line[] = [];
    for (const l of s.body) {
      if (l.startsWith("@@ ")) { before.push(null); after.push(null); continue; }
      const t = l.slice(1);
      if (l[0] === "+") { after.push({ text: t, changed: true }); if (f.foreign(t)) source = true; }
      else if (l[0] === "-") before.push({ text: t, changed: true });
      else if (l[0] === " ") { before.push({ text: t, changed: false }); after.push({ text: t, changed: false }); }
    }
    const was = records(f, before), now = records(f, after);
    // A changed checksum of a package the section does not show by name and version cannot be checked.
    if ([...was, ...now].some((r) => r.hashChanged && r.key === null)) checksum = true;
    const hashesOf = (rs: Rec[]) => {
      const m = new Map<string, Set<string>>();
      for (const r of rs) if (r.key && r.hashes.length) { const h = m.get(r.key) ?? new Set(); r.hashes.forEach((x) => h.add(x)); m.set(r.key, h); }
      return m;
    };
    const a = hashesOf(was), b = hashesOf(now);
    for (const [k, h] of b) { const o = a.get(k); if (o && (o.size !== h.size || [...h].some((x) => !o.has(x)))) checksum = true; }
  }
  return [...(source ? [LOCK_SOURCE_REASON] : []), ...(checksum ? [LOCK_CHECKSUM_REASON] : []), ...(alone ? [LOCK_ALONE_REASON] : []), ...(moved ? [LOCK_MOVED_REASON] : [])];
}
