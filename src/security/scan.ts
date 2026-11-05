// The security deep scan engine: threat model, one call per area, one verify call per finding, with a spend cap
// checked before every call. It runs in the runner's job process (step `security-scan`) on a pinned commit of the
// default branch; nothing here writes to GitHub.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { FindingVerification } from "../../web/src/api/types.ts";
import { ACTIVE_STATES, finishScan, scanRow } from "./store.ts";
import {
  SECURITY_REPO, parseCandidates, parseThreatModel, parseVerdict, survives, titleKey,
  type Candidate, type SecurityAreaInput, type SecurityModelInput, type SecurityVerifyInput, type ThreatArea, type ThreatModel,
} from "./rules.ts";

/** One model call. `cost` is null when the CLI reported none. */
export type Reply = { text: string; cost: number | null };
export type Ask = {
  (id: "security.model", input: SecurityModelInput): Promise<Reply | null>;
  (id: "security.area", input: SecurityAreaInput): Promise<Reply | null>;
  (id: "security.verify", input: SecurityVerifyInput): Promise<Reply | null>;
};
export type ScanDeps = {
  ask: Ask;
  /** The pinned commit of the default branch and a read-only directory of its files, or null when none can be made. */
  checkout: (repo: string) => Promise<{ dir: string; sha: string } | null>;
  cancelled: () => boolean;
  log: (line: string) => void;
  progress?: (line: string) => void;
};

/** What a call is expected to cost before any has run, in dollars. The area guess grows with the size of the area's files. */
export const MODEL_GUESS_USD = 2;
export const VERIFY_GUESS_USD = 0.6;
export const areaGuessUsd = (bytes: number): number => Math.min(6, 1 + bytes / 200_000);
const BYTES_CAP = 2_000_000;
const MAX_FILE = 2 * 1024 * 1024;
/** Calls are repeated once when the reply cannot be read. */
const ATTEMPTS = 2;

const now = (): string => new Date().toISOString();
const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Bytes of the regular files under `paths` in the checkout, counted up to BYTES_CAP; null when none of the paths exists. */
export function pathsBytes(dir: string, paths: string[]): number | null {
  const root = resolve(dir);
  let total = 0, any = false;
  const walk = (p: string): void => {
    if (total >= BYTES_CAP) return;
    let st;
    try { st = statSync(p); } catch { return; }
    any = true;
    if (st.isFile()) total += st.size;
    else if (st.isDirectory()) for (const e of readdirSync(p)) walk(join(p, e));
  };
  for (const p of paths) {
    const full = resolve(root, p);
    if (full === root || full.startsWith(root + sep)) walk(full);
  }
  return any ? total : null;
}

/** Keeps the refs that point at a line of a file in the checkout. */
function realRefs(dir: string, refs: Candidate["refs"]): Candidate["refs"] {
  const root = resolve(dir);
  return refs.filter((r) => {
    const full = resolve(root, r.path);
    if (!full.startsWith(root + sep) || !existsSync(full)) return false;
    try {
      const st = statSync(full);
      if (!st.isFile() || st.size > MAX_FILE) return false;
      return readFileSync(full, "utf8").split("\n").length >= r.line;
    } catch { return false; }
  });
}

type Known = { fingerprint: string; refs: { path: string; line: number }[] };

const fingerprintOf = (c: Candidate): string => `${c.refs[0]!.path}|${titleKey(c.title)}`;

/** A finding that matches an earlier one of the repository (any scan, any state): the same file and line, or the same title in the same file. */
const isDuplicate = (known: Known[], c: Candidate): boolean => {
  const fp = fingerprintOf(c);
  return known.some((k) => k.fingerprint === fp || k.refs.some((r) => c.refs.some((x) => x.path === r.path && x.line === r.line)));
};

class Capped extends Error {}
class Stopped extends Error {}

/**
 * Runs scan `scanId` (created by the API in state `modeling`) to the end: done, stopped, capped or failed.
 * Returns the summary line of the job.
 */
export async function runScan(db: DatabaseSync, scanId: number, deps: ScanDeps): Promise<string> {
  const scan = scanRow(db, scanId);
  if (!scan) throw new Error(`no scan ${scanId}`);
  if (!ACTIVE_STATES.includes(scan.state)) return `scan ${scanId} already ${scan.state}`;
  const { repo, cap_usd: cap } = scan;
  const stopped = (): boolean => deps.cancelled() || scanRow(db, scanId)?.state === "stopped";
  const setState = (state: "modeling" | "scanning" | "verifying"): void => void db.prepare(`UPDATE security_scans SET state = ? WHERE id = ? AND state IN (${ACTIVE_STATES.map((s) => `'${s}'`).join(", ")})`).run(state, scanId);
  const progress = (line: string): void => { deps.progress?.(line); deps.log(line); };
  const cost = (): number => scanRow(db, scanId)!.cost_usd;
  const areaCalls: number[] = [], verifyCalls: number[] = [];
  let areaGuess = areaGuessUsd(0);

  /** One call with the cap and stop checks before it; the call's cost goes to the scan and, for area work, to the area. */
  async function call<T>(kind: "model" | "area" | "verify", expected: number, meta: { area?: number; finding?: number; bill?: number }, run: () => Promise<Reply | null>, readReply: (text: string) => T | null): Promise<{ value: T; cost: number } | null> {
    let spent = 0;
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      if (stopped()) throw new Stopped();
      if (cap !== null && cost() + expected > cap) throw new Capped();
      const id = Number(db.prepare("INSERT INTO security_calls (scan_id, kind, area_idx, finding_number, started_at) VALUES (?, ?, ?, ?, ?)").run(scanId, kind, meta.area ?? null, meta.finding ?? null, now()).lastInsertRowid);
      let reply: Reply | null = null;
      try { reply = await run(); } catch (e) { deps.log(`${kind} call failed: ${(e as Error).message}`.slice(0, 300)); }
      const c = reply ? reply.cost ?? expected : 0;
      const value = reply ? readReply(reply.text) : null;
      db.prepare("UPDATE security_calls SET ended_at = ?, ok = ?, cost_usd = ? WHERE id = ?").run(now(), value === null ? 0 : 1, reply ? c : null, id);
      db.prepare("UPDATE security_scans SET cost_usd = cost_usd + ? WHERE id = ?").run(c, scanId);
      if (meta.bill !== undefined) db.prepare("UPDATE security_areas SET cost_usd = cost_usd + ? WHERE scan_id = ? AND idx = ?").run(c, scanId, meta.bill);
      spent += c;
      if (value !== null) return { value, cost: spent };
    }
    return null;
  }

  const fail = (msg: string): string => {
    finishScan(db, scanId, "failed", msg.slice(0, 500));
    return `${repo}: scan ${scanId} failed: ${msg}`;
  };

  try {
    const co = await deps.checkout(repo);
    if (!co) return fail("The repository could not be checked out for a read-only scan.");
    db.prepare("UPDATE security_scans SET commit_sha = ? WHERE id = ?").run(co.sha, scanId);
    const base = { repo: SECURITY_REPO, number: scanId, project: repo, commit: co.sha } as const;

    // ---- threat model ----
    setState("modeling");
    progress(`${repo}: threat model`);
    const modeled = await call<ThreatModel>("model", MODEL_GUESS_USD, {}, () => deps.ask("security.model", { ...base }), parseThreatModel);
    if (!modeled) return fail("The threat model could not be read.");
    const areas: ThreatArea[] = [];
    const sizes: number[] = [];
    for (const a of modeled.value.areas) {
      const bytes = pathsBytes(co.dir, a.paths);
      if (bytes === null) continue;
      areas.push(a);
      sizes.push(bytes);
    }
    if (!areas.length) return fail("The threat model named no area that exists in the checkout.");
    const insArea = db.prepare("INSERT INTO security_areas (scan_id, idx, name, paths, entry_points, risk, why) VALUES (?, ?, ?, ?, ?, ?, ?)");
    areas.forEach((a, i) => insArea.run(scanId, i, a.name, JSON.stringify(a.paths), JSON.stringify(a.entryPoints), a.risk, a.why));
    const guesses = sizes.map(areaGuessUsd);
    db.prepare("UPDATE security_scans SET areas_total = ?, estimate_usd = ?, threat_model = ? WHERE id = ?")
      .run(areas.length, cost() + guesses.reduce((x, y) => x + y, 0), JSON.stringify({ summary: modeled.value.summary, entryPoints: modeled.value.entryPoints }), scanId);

    const known: Known[] = (db.prepare("SELECT fingerprint, refs FROM security_findings WHERE repo = ?").all(repo) as { fingerprint: string; refs: string }[])
      .map((r) => ({ fingerprint: r.fingerprint, refs: (JSON.parse(r.refs) as { path: string; line: number }[]) }));
    const insFinding = db.prepare(`INSERT INTO security_findings (repo, number, scan_id, area, title, severity, urgent, state, refs, category, reach, impact, fingerprint, created_at, updated_at)
      VALUES (?, (SELECT COALESCE(MAX(number), 0) + 1 FROM security_findings WHERE repo = ?), ?, ?, ?, ?, ?, 'unverified', ?, ?, ?, ?, ?, ?, ?) RETURNING number`);

    // ---- areas ----
    for (const [idx, area] of areas.entries()) {
      areaGuess = mean(areaCalls) ?? guesses[idx]!;
      setState("scanning");
      progress(`${repo}: area ${idx + 1} of ${areas.length}: ${area.name}`);
      const input: SecurityAreaInput = {
        ...base, summary: modeled.value.summary, area: { name: area.name, paths: area.paths, why: area.why },
        entry_points: modeled.value.entryPoints.filter((e) => area.entryPoints.includes(e.name)),
      };
      const found = await call<Candidate[]>("area", areaGuess, { area: idx, bill: idx }, () => deps.ask("security.area", input), parseCandidates);
      if (!found) {
        db.prepare("UPDATE security_areas SET state = 'failed' WHERE scan_id = ? AND idx = ?").run(scanId, idx);
        deps.log(`area ${area.name}: no readable answer`);
      } else {
        areaCalls.push(found.cost);
        const fresh: { number: number; c: Candidate }[] = [];
        for (const c of found.value) {
          const refs = realRefs(co.dir, c.refs);
          if (!refs.length) continue;
          const cand: Candidate = { ...c, refs };
          if (isDuplicate(known, cand)) continue;
          const at = now();
          const row = insFinding.get(repo, repo, scanId, area.name, cand.title, cand.severity, cand.urgent ? 1 : 0, JSON.stringify(cand.refs), cand.category, cand.reach, cand.impact, fingerprintOf(cand), at, at) as { number: number };
          known.push({ fingerprint: fingerprintOf(cand), refs: cand.refs });
          fresh.push({ number: row.number, c: cand });
        }
        // ---- verify ----
        for (const f of fresh) {
          setState("verifying");
          progress(`${repo}: verifying "${f.c.title}"`);
          const vin: SecurityVerifyInput = { ...base, number: scanId, finding: { ...f.c, area: area.name } };
          const checked = await call("verify", mean(verifyCalls) ?? VERIFY_GUESS_USD, { finding: f.number, bill: idx }, () => deps.ask("security.verify", vin), parseVerdict);
          if (!checked) {
            const v: FindingVerification = { kind: "reasoning", result: "Not verified: the verify call gave no readable answer.", notes: "", score: null, proposedTest: null };
            db.prepare("UPDATE security_findings SET state = 'new', verification = ?, updated_at = ? WHERE repo = ? AND number = ?").run(JSON.stringify(v), now(), repo, f.number);
            continue;
          }
          verifyCalls.push(checked.cost);
          const verdict = checked.value;
          const v: FindingVerification = { kind: "reasoning", result: verdict.result, notes: verdict.notes, score: verdict.score, proposedTest: verdict.proposedTest };
          db.prepare("UPDATE security_findings SET state = ?, verification = ?, updated_at = ? WHERE repo = ? AND number = ?").run(survives(verdict) ? "new" : "disproved", JSON.stringify(v), now(), repo, f.number);
        }
      }
      db.prepare("UPDATE security_areas SET state = CASE state WHEN 'failed' THEN 'failed' ELSE 'done' END WHERE scan_id = ? AND idx = ?").run(scanId, idx);
      const left = guesses.slice(idx + 1);
      const avg = (db.prepare("SELECT AVG(cost_usd) AS a FROM security_areas WHERE scan_id = ? AND state != 'pending'").get(scanId) as { a: number }).a;
      db.prepare("UPDATE security_scans SET areas_done = ?, estimate_usd = ? WHERE id = ?").run(idx + 1, cost() + left.length * avg, scanId);
    }
    finishScan(db, scanId, "done");
    return `${repo}: scan ${scanId} done: ${areas.length} areas, ${(db.prepare("SELECT COUNT(*) AS n FROM security_findings WHERE scan_id = ? AND state = 'new'").get(scanId) as { n: number }).n} findings, $${cost().toFixed(2)}`;
  } catch (e) {
    if (e instanceof Capped) {
      finishScan(db, scanId, "capped");
      return `${repo}: scan ${scanId} stopped at the spend cap ($${cost().toFixed(2)} of $${cap})`;
    }
    if (e instanceof Stopped) {
      finishScan(db, scanId, "stopped");
      return `${repo}: scan ${scanId} stopped`;
    }
    finishScan(db, scanId, "failed", (e as Error).message.slice(0, 500));
    throw e;
  }
}
