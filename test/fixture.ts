// Fills a database at the spec's real scale (acceptance item 1): 25,000 open
// items over 20 repos, 75,000 closed, 500 decisions including batches, 2,000
// stage rows, 40 overrides and token rows. Every private field carries MARKER
// so the export check can grep for it.
import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { connect } from "../src/db.ts";

export const MARKER = "PRIVATE-MARKER-q7z";
export const ADMIN = "admin-test";
export const REPOS = Array.from({ length: 20 }, (_, i) => `app-${String(i + 1).padStart(2, "0")}`);

export type Scale = { open: number; closed: number; decisions: number; batches: number; stages: number; overrides: number };
export const FULL: Scale = { open: 25_000, closed: 75_000, decisions: 450, batches: 50, stages: 2_000, overrides: 40 };

// Small deterministic PRNG so every run builds the same data.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TYPES = ["bugfix", "performance", "missing feature", "small extra", "plugin candidate", "infra"];
const WANTS = ["yes", "no", "unclear"];

export function buildFixture(path: string, scale: Scale = FULL): DatabaseSync {
  if (existsSync(path)) throw new Error(`fixture exists: ${path}`);
  const db = connect(path);
  const r = rng(42);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const now = Date.now();
  const iso = (t: number) => new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
  const DAY = 86400_000;
  const start = now - 14 * DAY;
  // a few prolific authors, a long tail of one-timers
  const author = () => `user${String(Math.floor(3000 * r() ** 3)).padStart(4, "0")}`;

  db.exec("BEGIN");
  db.prepare("INSERT OR REPLACE INTO settings VALUES ('run_started_at', ?)").run(iso(start));
  const repoIns = db.prepare("INSERT INTO repos (name, visibility, default_branch, open_prs, open_issues, synced_at) VALUES (?, 'public', 'main', 0, 0, ?)");
  for (const name of REPOS) repoIns.run(name, iso(now));

  const itemIns = db.prepare(`INSERT INTO items (repo, number, kind, state, title, body, url, author, created_at, updated_at, closed_at, merged_at,
    labels, assignees, comments_count, additions, deletions, changed_files, mergeable, ci_state, closing_issues, detail_level)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const next = new Map(REPOS.map((x) => [x, 1]));
  // repo sizes are skewed too
  const repoOf = () => REPOS[Math.floor(REPOS.length * r() ** 1.6)];
  const open: { repo: string; number: number; kind: string }[] = [];
  const recentDone: { repo: string; number: number; state: string }[] = [];
  const add = (state: string) => {
    const repo = repoOf();
    const number = next.get(repo)!;
    next.set(repo, number + 1);
    const kind = r() < 0.6 ? "pr" : "issue";
    const st = kind === "issue" && state === "MERGED" ? "CLOSED" : state;
    const created = state === "OPEN" ? now - 720 * DAY * r() ** 2 : now - 730 * DAY * r();
    let closed: number | null = null;
    if (st !== "OPEN") {
      // about 4% of closed items closed since the run started
      closed = r() < 0.04 ? Math.max(created, start) + (now - Math.max(created, start)) * r() : created + (Math.min(now, start) - created) * r();
      if (closed < created) closed = created;
    }
    const lines = Math.floor(2000 * r() ** 3);
    const title = number % 997 === 0 ? `<script>alert("x")</script> & "quoted" title ${number}` : `${pick(["Fix", "Add", "Improve", "Support"])} ${pick(["export", "layers", "brush", "zoom", "undo"])} ${number}`;
    itemIns.run(repo, number, kind, st, title, `Body of ${repo}#${number}`, `https://github.com/storytold/${repo}/${kind === "pr" ? "pull" : "issues"}/${number}`,
      r() < 0.02 ? null : author(), iso(created), iso(closed ?? created), closed === null ? null : iso(closed), st === "MERGED" ? iso(closed!) : null,
      JSON.stringify(r() < 0.3 ? [pick(["bug", "enhancement", "ui"])] : []), "[]", Math.floor(r() * 10),
      kind === "pr" ? Math.floor(lines * 0.7) : null, kind === "pr" ? lines - Math.floor(lines * 0.7) : null, kind === "pr" ? 1 + Math.floor(r() * 20) : null,
      kind === "pr" && st === "OPEN" ? pick(["MERGEABLE", "CONFLICTING", "UNKNOWN"]) : null, kind === "pr" && st === "OPEN" ? pick(["SUCCESS", "FAILURE", "PENDING"]) : null,
      kind === "pr" ? JSON.stringify(r() < 0.2 ? [Math.max(1, number - 1 - Math.floor(r() * 50))] : []) : null, st === "OPEN" ? "full" : "light");
    if (st === "OPEN") open.push({ repo, number, kind });
    else if (closed! >= start) recentDone.push({ repo, number, state: st });
  };
  for (let i = 0; i < scale.open; i++) add("OPEN");
  for (let i = 0; i < scale.closed; i++) add(r() < 0.66 ? "MERGED" : "CLOSED");

  const clsIns = db.prepare("INSERT INTO classifications (repo, number, classifier, run_id, at, type_label, want, reference, topics, flags, dup_of, area, reason) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)");
  open.forEach((it, i) => {
    const truth = pick(TYPES);
    const want = pick(WANTS);
    const at = iso(start + (now - start) * r());
    const vote = (cls: string, acc: number) => clsIns.run(it.repo, it.number, cls, `run-${cls}-1`, at, r() < acc ? truth : pick(TYPES), r() < acc ? want : pick(WANTS),
      r() < 0.1 ? "Filter › Distort › Wave" : null, "1", "[]", r() < 0.02 ? Math.max(1, it.number - 1) : null, pick(["canvas", "export", "ui", "io"]), `Looks like ${truth}`);
    if (i % 5 !== 4) vote("haiku", 0.8);
    if (i % 2 === 0) vote("jev", 0.75);
    if (i % 16 === 0) vote("sonnet", 0.9);
    if (i % 500 === 0) vote("owner", 1);
  });

  const stageIns = db.prepare("INSERT INTO stages (repo, number, stage, at, actor, note) VALUES (?,?,?,?,?,?)");
  const STAGES = ["classified", "reviewed", "take", "hold", "close", "needs-decision", "batched"];
  let stages = 0;
  for (const it of recentDone.slice(0, Math.floor(scale.stages * 0.3))) {
    const s = it.state === "MERGED" ? "merged" : r() < 0.5 ? "closed" : "fixed-by-us";
    stageIns.run(it.repo, it.number, s, iso(now - DAY * r() * 13), "pipeline", `Done: ${s}`);
    stages++;
  }
  for (let i = 0; stages < scale.stages; i++) {
    const it = open[(i * 7) % open.length];
    stageIns.run(it.repo, it.number, STAGES[i % STAGES.length], iso(start + (now - start) * r()), "pipeline", "Moved by the pipeline");
    stages++;
  }

  const decIns = db.prepare(`INSERT INTO decisions (id, kind, repo, number, items, question, context, facts, options, recommended, public_text, asked_at, asked_by,
    answer, answer_note, exceptions, answered_by, answered_at, applied_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const KINDS = ["scope", "duplicate", "close", "merge", "split", "other"];
  const opts = JSON.stringify([{ key: "small", label: "Small extra" }, { key: "plugin", label: "Plugin candidate" }, { key: "close", label: "Close" }]);
  const answered = (i: number) => i % 5 === 0;
  for (let i = 0; i < scale.decisions; i++) {
    const it = open[(i * 37 + 11) % open.length];
    const a = answered(i);
    decIns.run(`${it.repo}#${it.number}:${KINDS[i % KINDS.length]}`, KINDS[i % KINDS.length], it.repo, it.number, null,
      "Beyond the reference app: label small extra or plugin candidate?", "The PR adds a wave filter. The reference app has one too.",
      JSON.stringify(["+120 −8, 3 files", "author: 14 merged PRs", "reference app: Filter › Distort › Wave"]), opts, "small",
      i % 3 === 0 ? "Thanks! This fits better as a plugin." : null, iso(now - DAY * 10 * r()), "triage-agent",
      a ? "small" : null, a ? `note ${MARKER}` : null, null, a ? ADMIN : null, a ? iso(now - DAY * r()) : null, a && i % 10 === 0 ? iso(now - DAY * r()) : null);
  }
  for (let b = 0; b < scale.batches; b++) {
    const n = 5 + (b % 25);
    const refs = Array.from({ length: n }, (_, k) => {
      const it = open[(b * 101 + k * 13) % open.length];
      return { repo: it.repo, number: it.number };
    });
    // even batches stay in one repo
    if (b % 2 === 0) for (const x of refs) x.repo = refs[0].repo;
    const repos = new Set(refs.map((x) => x.repo));
    const a = b % 7 === 0;
    decIns.run(`batch-${b}`, b % 2 ? "scope" : "close", repos.size === 1 ? refs[0].repo : null, null, JSON.stringify(refs),
      "Close these stale PRs with a short thank-you?", null, JSON.stringify([`${n} PRs`, "no activity for 1 year"]),
      JSON.stringify([{ key: "close", label: "Close all" }, { key: "keep", label: "Keep open" }]), "close", "Closing as stale; thanks for the work.",
      iso(now - DAY * 5 * r()), "triage-agent", a ? "close" : null, a ? `batch note ${MARKER}` : null, a ? JSON.stringify([{ ...refs[0], answer: "keep" }]) : null,
      a ? ADMIN : null, a ? iso(now - DAY * r()) : null, null);
  }

  const ovIns = db.prepare("INSERT INTO whitelist_overrides (login, status, note, by, at) VALUES (?,?,?,?,?)");
  for (let i = 0; i < scale.overrides; i++) ovIns.run(`user${String(i * 7).padStart(4, "0")}`, i % 3 ? "allow" : "deny", `override ${MARKER}`, ADMIN, iso(now - DAY * r() * 30));

  const tokIns = db.prepare(`INSERT INTO token_usage (run_id, agent, stage, model, repo, items, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, started_at, ended_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (let i = 0; i < 400; i++) {
    const stage = pick(["classify", "review", "fix", "merge"]);
    const t = start + (now - start) * r();
    tokIns.run(`run-${i}`, `agent-${i}`, stage, stage === "classify" ? pick(["haiku", "jev"]) : "sonnet", pick(REPOS), 1 + Math.floor(r() * 100),
      Math.floor(r() * 2e6), Math.floor(r() * 2e5), Math.floor(r() * 5e6), Math.floor(r() * 5e5), iso(t), iso(t + 600_000));
  }

  const accIns = db.prepare("INSERT INTO access (login, role, added_by, added_at, note) VALUES (?,?,?,?,?)");
  accIns.run(ADMIN, "admin", "cli", iso(now), `admin ${MARKER}`);
  accIns.run("viewer-test", "viewer", ADMIN, iso(now), `viewer ${MARKER}`);
  db.exec("COMMIT");
  db.exec("ANALYZE");
  return db;
}
