// GitHub side of the Label stage: ensure the label set exists, add labels to items.
// Every call goes through the mirror's Querier (gh api graphql, rate-limit aware).
import { CLI_BY, type By } from "../core/gates.ts";
import { guardItem, guardRepo, type GuardedItem } from "../core/guard.ts";
import { setTimeout as sleepMs } from "node:timers/promises";
import type { DatabaseSync } from "node:sqlite";
import { addLabels, createLabel, type Writer } from "../github/write.ts";
import { Transient, type Querier } from "../mirror.ts";
import { approvalOf } from "./approval.ts";
import { plannedItems } from "../core/select-items.ts";
import { ALL_LABELS, type LabelDef } from "./set.ts";
import { jobItem } from "../runner/job-items.ts";
import { ownerOf } from "../owners.ts";
import { repoIdentity } from "../github/identity.ts";
import { authFailure, isWaiting, laneForDecision, noWriteReason, setExecState, SIGN_IN_REASON, type LaneDeps } from "../github/user-lane.ts";

export const BATCH = 10;          // mutations per request
export const WRITES_PER_MIN = 60; // GitHub asks integrators to stay near this for content-creating writes
const NODE_LOOKUP = 25;

export class LabelsError extends Error {}

type Wait = (ms: number) => Promise<void>;

async function retrying<T>(f: () => Promise<T>, wait: Wait): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await f();
    } catch (e) {
      if (!(e instanceof Transient) || i >= 5) throw e;
      await wait(5_000 * i);
    }
  }
}

type Repo = { id: string; labels: Map<string, string> }; // lower-case name -> label id

export const repoLabelsQuery = (): string => `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id
    ${ALL_LABELS.map((l, i) => `l${i}: label(name: ${JSON.stringify(l.name)}) { id name }`).join("\n")} } }`;

export async function repoLabels(client: Querier, repo: string, wait: Wait = sleepMs as Wait): Promise<Repo> {
  const d = await retrying(() => client.query(repoLabelsQuery(), { owner: ownerOf(repo), name: repo }), wait);
  if (!d.repository) throw new LabelsError(`repo ${repo} not found`);
  const labels = new Map<string, string>();
  ALL_LABELS.forEach((l, i) => {
    const hit = d.repository[`l${i}`];
    if (hit) labels.set(l.name.toLowerCase(), hit.id);
  });
  return { id: d.repository.id, labels };
}

// Creates the missing labels of the set. Returns the names missing (created when apply).
export async function ensureLabels(client: Querier, repo: string, apply: boolean, w: Writer, wait: Wait = sleepMs as Wait, by: By = CLI_BY): Promise<LabelDef[]> {
  const have = await repoLabels(client, repo, wait);
  const missing = ALL_LABELS.filter((l) => !have.labels.has(l.name.toLowerCase()));
  if (apply && missing.length) {
    const g = guardRepo(w.db, repo, "labels", by);
    if ("refused" in g) throw new LabelsError(g.refused);
    for (const l of missing) {
      await createLabel(w, g, client, repo, have.id, { name: l.name, color: l.color, description: l.description }, (f) => retrying(f, wait));
      await wait(1_000);
    }
  }
  return missing;
}

export type ApplyResult = { planned: number; labeled: number; failed: number[]; skipped: number; batches: number; dryRun: boolean };
export type ApplyOpts = { runId: string; limit?: number; apply: boolean; login?: string; /** Who asked; default: an operator at the command line. */ by?: By; wait?: Wait; log?: (s: string) => void;
  /** Called with the running count of items labelled, after each batch. */
  onLabeled?: (labeled: number) => void;
  /** The user lane's token source and transports; default: the secrets file's app. */
  lane?: LaneDeps };

/** The scope decision an operator answered "plugin" for this item: its answer is what adds the plugin candidate label, so its operator writes it. */
export function pluginDecisionOf(db: DatabaseSync, repo: string, number: number): string | undefined {
  return (db.prepare(`SELECT id FROM main.decisions WHERE kind = 'scope' AND repo = ? AND number = ? AND answer = 'plugin' AND answered_by IN (SELECT login FROM main.access WHERE role = 'operator')
    ORDER BY answered_at DESC LIMIT 1`).get(repo, number) as { id: string } | undefined)?.id;
}

/** An item the Plans give labels to, and the labels to add. */
type Todo = { number: number; add: string[] };

export async function applyLabels(db: DatabaseSync, client: Querier, repo: string, o: ApplyOpts): Promise<ApplyResult> {
  const wait = o.wait ?? (sleepMs as Wait);
  const log = o.log ?? (() => {});
  const w: Writer = { db, login: o.login ?? "cli" };
  const approval = approvalOf(db, repo);
  if (o.apply && !approval) {
    throw new LabelsError(`${repo} is not approved for labelling. An operator approves it on the dashboard Repos page.`);
  }
  // An item whose plugin label waits for its operator's token or access is left out until it is retried.
  const waits = (n: number) => repoIdentity(db, repo) === "app" && isWaiting(db, pluginDecisionOf(db, repo, n));
  let todo: Todo[] = plannedItems(db, "label", { repo, run: o.runId }).filter((p) => !waits(p.facts.number)).map((p) => ({ number: p.facts.number, add: p.action.params!.add as string[] }));
  if (o.limit !== undefined) todo = todo.slice(0, o.limit);
  const res: ApplyResult = { planned: todo.length, labeled: 0, failed: [], skipped: 0, batches: 0, dryRun: !o.apply };
  if (!o.apply) {
    for (const r of todo) log(`${repo}#${r.number}: would add ${r.add.join(", ")}`);
    return res;
  }
  const have = await repoLabels(client, repo, wait);
  const needed = new Set(todo.flatMap((r) => r.add.map((a) => a.toLowerCase())));
  const unknown = [...needed].filter((n) => !have.labels.has(n));
  if (unknown.length) throw new LabelsError(`missing labels on ${repo}: ${unknown.join(", ")}; run labels ensure --repo ${repo} --apply`);

  for (let i = 0; i < todo.length; i += BATCH) {
    const chunk = todo.slice(i, i + BATCH);
    const started = Date.now();
    const ids = await nodeIds(client, repo, chunk.map((r) => r.number), wait);
    const live = (r: Todo) => ids.get(r.number);
    const gone = chunk.filter((r) => live(r)?.id && live(r)!.state && live(r)!.state !== "OPEN");
    for (const r of gone) {
      db.prepare("UPDATE main.items SET state = ? WHERE repo = ? AND number = ? AND state = 'OPEN'").run(live(r)!.state, repo, r.number);
      log(`${repo}#${r.number}: skipped, now ${live(r)!.state} on GitHub`);
    }
    res.skipped += gone.length;
    const writable = chunk.filter((r) => live(r)?.id && !gone.includes(r));
    for (const r of chunk) if (!live(r)?.id) res.failed.push(r.number);
    const idMap = new Map([...ids].map(([n, v]) => [n, v.id] as [number, string | null]));
    // Each item is guarded right before its labels are written: the Plan must still add them.
    const grants = new Map<number, GuardedItem>();
    // A label an operator's answer adds (plugin candidate) is written as that operator in a repo on the app's identity; the rest stay with the stage's own account.
    const asUser = new Map<number, string>();
    for (const r of writable) {
      const dec = repoIdentity(db, repo) === "app" ? pluginDecisionOf(db, repo, r.number) : undefined;
      const g = await guardItem(db, { repo, number: r.number }, { kind: "label" }, o.by ?? CLI_BY, dec);
      if ("refused" in g) { log(`${repo}#${r.number}: not labelled: ${g.refused}`); res.skipped++; } else { grants.set(r.number, g); if (dec) asUser.set(r.number, dec); }
    }
    const guarded = writable.filter((r) => grants.has(r.number));
    const done: number[] = [];
    const plain = guarded.filter((r) => !asUser.has(r.number));
    if (plain.length) done.push(...await mutate(w, client, repo, plain, idMap, have, wait, o.runId, grants));
    for (const r of guarded.filter((x) => asUser.has(x.number))) {
      const dec = asUser.get(r.number)!;
      const lr = await laneForDecision(db, o.lane, dec, [repo]);
      if (lr && !("lane" in lr)) {
        if (!("transient" in lr)) { setExecState(db, dec, lr.state, lr.reason); log(`${repo}#${r.number}: waiting: ${lr.reason}`); }
        res.skipped++;
        continue;
      }
      if (lr) setExecState(db, dec, "pending");
      try {
        done.push(...await addLabels(w, lr ? lr.lane.querier : client, repo,
          [{ number: r.number, id: idMap.get(r.number)!, labelIds: r.add.map((a) => have.labels.get(a.toLowerCase())!), names: r.add, g: grants.get(r.number)! }], (f) => retrying(f, wait), { run: o.runId }));
      } catch (e) {
        const why = String((e as Error).message ?? e).replace(/\s+/g, " ").slice(0, 300);
        const denied = lr ? authFailure(e) : null;
        if (denied === "transient") { res.skipped++; continue; }
        if (denied) { setExecState(db, dec, denied, denied === "waiting-token" ? SIGN_IN_REASON : noWriteReason(repo)); res.skipped++; continue; }
        if (lr) setExecState(db, dec, "failed", why);
        throw e;
      }
    }
    for (const r of guarded) if (!done.includes(r.number)) res.failed.push(r.number);
    const ok = guarded.filter((r) => done.includes(r.number));
    if (ok.length) {
      const at = new Date().toISOString();
      db.exec("BEGIN IMMEDIATE");
      for (const r of ok) {
        db.prepare("INSERT INTO main.stages (repo, number, stage, at, actor, note) VALUES (?, ?, 'labeled', ?, 'labels', ?)")
          .run(repo, r.number, at, `added: ${r.add.join(", ")}`);
      }
      db.exec("COMMIT");
      for (const r of ok) jobItem(db, repo, r.number, `labelled ${r.add.join(", ")}`, log);
      res.labeled += ok.length;
      o.onLabeled?.(res.labeled);
    }
    res.batches++;
    log(`${repo}: batch ${res.batches}: labelled ${ok.length} of ${chunk.length}`);
    const minMs = (chunk.length * 60_000) / WRITES_PER_MIN;
    const spent = Date.now() - started;
    if (spent < minMs && i + BATCH < todo.length) await wait(minMs - spent);
  }
  return res;
}

type Live = { id: string | null; state: string | null };

export const nodeIdsQuery = (numbers: number[]): string => `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) {
      ${numbers.map((n) => `n${n}: issueOrPullRequest(number: ${n}) { ... on Issue { id state } ... on PullRequest { id state } }`).join("\n")} } }`;

// One batched read per chunk: the node id to write to and the live state, which can be ahead of the mirror.
async function nodeIds(client: Querier, repo: string, numbers: number[], wait: Wait): Promise<Map<number, Live>> {
  const out = new Map<number, Live>();
  for (let i = 0; i < numbers.length; i += NODE_LOOKUP) {
    const part = numbers.slice(i, i + NODE_LOOKUP);
    const d = await retrying(() => client.query(nodeIdsQuery(part), { owner: ownerOf(repo), name: repo }), wait);
    for (const n of part) {
      const node = d.repository?.[`n${n}`];
      out.set(n, { id: node?.id ?? null, state: node?.state ?? null });
    }
  }
  return out;
}

// Returns the numbers whose mutation succeeded. A failed batch is retried item by item.
async function mutate(w: Writer, client: Querier, repo: string, rows: Todo[], ids: Map<number, string | null>, have: Repo, wait: Wait, runId: string, grants: Map<number, GuardedItem>): Promise<number[]> {
  const run = (part: Todo[]): Promise<number[]> => addLabels(w, client, repo,
    part.map((r) => ({ number: r.number, id: ids.get(r.number)!, labelIds: r.add.map((a) => have.labels.get(a.toLowerCase())!), names: r.add, g: grants.get(r.number)! })),
    (f) => retrying(f, wait), { run: runId });
  try {
    return await run(rows);
  } catch (e) {
    if (e instanceof Transient || rows.length === 1) {
      if (e instanceof Transient) throw e;
      return [];
    }
    const out: number[] = [];
    for (const r of rows) {
      try {
        out.push(...(await run([r])));
      } catch (e2) {
        if (e2 instanceof Transient) throw e2;
      }
    }
    return out;
  }
}
