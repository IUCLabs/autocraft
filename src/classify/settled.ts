// The settled type label of an item for one classification run. Jev judges
// every item; Haiku gives a second opinion on the items Jev is unsure about.
//
// - Jev's top probability >= SURE: Jev's label is settled.
// - Otherwise, Haiku agrees with Jev: settled with that label.
// - Otherwise unsettled: "waiting" while Haiku hasn't answered, "disagree" when
//   it gave another label.
// - No Jev verdict in the run: "unclassified".
//
// settle() is the rule; settledOf() applies it to one item and settledTable()
// to a whole run for queries.
import type { DatabaseSync } from "node:sqlite";

export const SURE = 0.9;

export type SettledStatus = "settled" | "waiting" | "disagree" | "unclassified";

export type Verdict = { label: string; flags: string[] };

export type Settled = {
  status: SettledStatus;
  label: string | null;          // set only when status is "settled"
  source: "jev" | "haiku" | null;
  confidence: number | null;     // Jev's top probability
  jevLabel: string | null;
  haikuLabel: string | null;
  // Jev's flags when Jev is sure; otherwise every flag either classifier raised.
  flags: string[];
};

export function settle(jev: (Verdict & { top: number | null }) | null, haiku: Verdict | null): Settled {
  if (!jev) return { status: "unclassified", label: null, source: null, confidence: null, jevLabel: null, haikuLabel: haiku?.label ?? null, flags: [] };
  const base = { confidence: jev.top, jevLabel: jev.label, haikuLabel: haiku?.label ?? null };
  if ((jev.top ?? 0) >= SURE) return { ...base, status: "settled", label: jev.label, source: "jev", flags: [...jev.flags] };
  const flags = [...new Set([...jev.flags, ...(haiku?.flags ?? [])])];
  if (!haiku) return { ...base, status: "waiting", label: null, source: null, flags };
  if (haiku.label === jev.label) return { ...base, status: "settled", label: jev.label, source: "haiku", flags };
  return { ...base, status: "disagree", label: null, source: null, flags };
}

// The run the dashboard shows: the current classification run (settings.classify_run), else the one with the newest Jev verdict.
export function latestRun(db: DatabaseSync): string | null {
  const set = db.prepare("SELECT value FROM settings WHERE key = 'classify_run'").get() as { value: string } | undefined;
  if (set?.value) return set.value;
  const r = db.prepare("SELECT run_id FROM classifications WHERE classifier = 'jev' ORDER BY at DESC LIMIT 1").get() as { run_id: string } | undefined;
  return r?.run_id ?? null;
}

const parseFlags = (s: string | null): string[] => {
  try {
    const f = JSON.parse(s ?? "[]") as unknown;
    return Array.isArray(f) ? f.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
};

export function settledOf(db: DatabaseSync, repo: string, number: number, run = latestRun(db)): Settled {
  if (!run) return settle(null, null);
  const q = db.prepare("SELECT type_label, flags, probs FROM classifications WHERE repo = ? AND number = ? AND classifier = ? AND run_id = ?");
  const j = q.get(repo, number, "jev", run) as { type_label: string; flags: string | null; probs: string | null } | undefined;
  const h = q.get(repo, number, "haiku", run) as { type_label: string; flags: string | null } | undefined;
  return settle(
    j ? { label: j.type_label, flags: parseFlags(j.flags), top: topOf(j.probs) } : null,
    h ? { label: h.type_label, flags: parseFlags(h.flags) } : null,
  );
}

function topOf(probs: string | null): number | null {
  try {
    const t = (JSON.parse(probs ?? "null") as { top?: unknown } | null)?.top;
    return typeof t === "number" ? t : null;
  } catch { return null; }
}

// Settled verdicts of one run as a temp table on this connection, for queries
// that count or filter many items:
//   temp.item_settled(repo, number, status, label, source, top, jev_label, haiku_label, flags JSON, security, needs_decision)
// Items without a Jev verdict have no row ("unclassified"). Classifiers only
// insert (INSERT OR REPLACE gives a new rowid), so verdicts with a rowid above
// the last one seen are applied item by item; a new run or fewer rows than
// expected rebuilds the table.
type Seen = { run: string | null; maxRowid: number; count: number };
const seen = new WeakMap<DatabaseSync, Seen>();

type VerdictRow = { repo: string; number: number; jl: string; jf: string | null; probs: string | null; hl: string | null; hf: string | null };
const VERDICTS = `SELECT j.repo, j.number, j.type_label AS jl, j.flags AS jf, j.probs, h.type_label AS hl, h.flags AS hf
  FROM main.classifications j
  LEFT JOIN main.classifications h ON h.repo = j.repo AND h.number = j.number AND h.classifier = 'haiku' AND h.run_id = j.run_id
  WHERE j.run_id = :run AND j.classifier = 'jev'`;

export function settledTable(db: DatabaseSync, run: string | null): void {
  const now = db.prepare("SELECT COALESCE(MAX(rowid), 0) AS maxRowid, COUNT(*) AS count FROM main.classifications").get() as { maxRowid: number; count: number };
  const prev = seen.get(db);
  if (prev && prev.run === run && prev.maxRowid === now.maxRowid && prev.count === now.count) return;
  db.exec(`CREATE TEMP TABLE IF NOT EXISTS item_settled (repo TEXT NOT NULL, number INTEGER NOT NULL, status TEXT NOT NULL, label TEXT,
    source TEXT, top REAL, jev_label TEXT, haiku_label TEXT, flags TEXT NOT NULL, security INTEGER NOT NULL, needs_decision INTEGER NOT NULL,
    PRIMARY KEY (repo, number))`);
  const ins = db.prepare("INSERT OR REPLACE INTO temp.item_settled VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const put = (r: VerdictRow) => {
    const s = settle({ label: r.jl, flags: parseFlags(r.jf), top: topOf(r.probs) }, r.hl === null ? null : { label: r.hl, flags: parseFlags(r.hf) });
    ins.run(r.repo, r.number, s.status, s.label, s.source, s.confidence, s.jevLabel, s.haikuLabel, JSON.stringify(s.flags),
      s.flags.includes("security") ? 1 : 0, s.flags.includes("needs decision") ? 1 : 0);
  };
  db.exec("BEGIN");
  try {
    const fresh = prev && prev.run === run
      ? (db.prepare("SELECT DISTINCT repo, number FROM main.classifications WHERE rowid > ? AND run_id = ?").all(prev.maxRowid, run) as { repo: string; number: number }[])
      : null;
    const added = prev ? (db.prepare("SELECT COUNT(*) AS n FROM main.classifications WHERE rowid > ?").get(prev.maxRowid) as { n: number }).n : 0;
    // INSERT OR REPLACE removes one row for each it adds, so the count only falls when something was deleted.
    if (fresh && run && now.count >= prev!.count && now.count <= prev!.count + added) {
      const one = db.prepare(`${VERDICTS} AND j.repo = :repo AND j.number = :number`);
      for (const k of fresh) {
        const r = one.get({ run, repo: k.repo, number: k.number }) as VerdictRow | undefined;
        if (r) put(r);
        else db.prepare("DELETE FROM temp.item_settled WHERE repo = ? AND number = ?").run(k.repo, k.number);
      }
    } else {
      db.exec("DELETE FROM temp.item_settled");
      if (run) for (const r of db.prepare(VERDICTS).all({ run }) as VerdictRow[]) put(r);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  seen.set(db, { run, ...now });
}

export type SettledRow = {
  status: string | null; label: string | null; source: string | null;
  top: number | null; jev_label: string | null; haiku_label: string | null; flags: string | null;
};

// A temp.item_settled row (or none) as the wire shape.
export function fromRow(r: Partial<SettledRow> | undefined): Settled {
  if (!r?.status) return settle(null, null);
  return {
    status: r.status as SettledStatus, label: r.label ?? null, source: (r.source as Settled["source"]) ?? null,
    confidence: r.top ?? null, jevLabel: r.jev_label ?? null, haikuLabel: r.haiku_label ?? null, flags: parseFlags(r.flags ?? null),
  };
}
