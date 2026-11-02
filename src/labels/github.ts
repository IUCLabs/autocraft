// GitHub side of the Label stage: ensure the label set exists, add labels to items.
// Every call goes through the mirror's Querier (gh api graphql, rate-limit aware).
import { setTimeout as sleepMs } from "node:timers/promises";
import type { DatabaseSync } from "node:sqlite";
import { audit } from "../dash/audit.ts";
import { Transient, type Querier } from "../mirror.ts";
import { approvalOf } from "./approval.ts";
import { planLabels, type PlanRow } from "./plan.ts";
import { ALL_LABELS, type LabelDef } from "./set.ts";

const ORG = "storytold";
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

export async function repoLabels(client: Querier, repo: string, wait: Wait = sleepMs as Wait): Promise<Repo> {
  const q = `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id
    ${ALL_LABELS.map((l, i) => `l${i}: label(name: ${JSON.stringify(l.name)}) { id name }`).join("\n")} } }`;
  const d = await retrying(() => client.query(q, { owner: ORG, name: repo }), wait);
  if (!d.repository) throw new LabelsError(`repo ${repo} not found`);
  const labels = new Map<string, string>();
  ALL_LABELS.forEach((l, i) => {
    const hit = d.repository[`l${i}`];
    if (hit) labels.set(l.name.toLowerCase(), hit.id);
  });
  return { id: d.repository.id, labels };
}

// Creates the missing labels of the set. Returns the names missing (created when apply).
export async function ensureLabels(client: Querier, repo: string, apply: boolean, wait: Wait = sleepMs as Wait): Promise<LabelDef[]> {
  const have = await repoLabels(client, repo, wait);
  const missing = ALL_LABELS.filter((l) => !have.labels.has(l.name.toLowerCase()));
  if (apply) {
    for (const l of missing) {
      await retrying(() => client.query(
        `mutation($input: CreateLabelInput!) { createLabel(input: $input) { label { id } } }`,
        { input: { repositoryId: have.id, name: l.name, color: l.color, description: l.description } }), wait);
      await wait(1_000);
    }
  }
  return missing;
}

export type ApplyResult = { planned: number; labeled: number; failed: number[]; batches: number; dryRun: boolean };
export type ApplyOpts = { runId: string; limit?: number; apply: boolean; login?: string; wait?: Wait; log?: (s: string) => void };

// Items a previous apply already labelled (resumability): the latest `labeled` stage row names every label we would add.
function alreadyApplied(db: DatabaseSync, repo: string, r: PlanRow): boolean {
  const s = db.prepare("SELECT note FROM main.stages WHERE repo = ? AND number = ? AND stage = 'labeled' ORDER BY at DESC, rowid DESC LIMIT 1")
    .get(repo, r.number) as { note: string | null } | undefined;
  if (!s?.note) return false;
  const done = s.note.replace(/^added: /, "").split(", ");
  return r.add.every((a) => done.some((d) => d.toLowerCase() === a.toLowerCase()));
}

export async function applyLabels(db: DatabaseSync, client: Querier, repo: string, o: ApplyOpts): Promise<ApplyResult> {
  const wait = o.wait ?? (sleepMs as Wait);
  const log = o.log ?? (() => {});
  const approval = approvalOf(db, repo);
  if (o.apply && !approval) {
    throw new LabelsError(`${repo} is not approved for labelling. An operator approves it on the dashboard Repos page.`);
  }
  let todo = planLabels(db, repo, o.runId).filter((r) => r.status === "add" && !alreadyApplied(db, repo, r));
  if (o.limit !== undefined) todo = todo.slice(0, o.limit);
  const res: ApplyResult = { planned: todo.length, labeled: 0, failed: [], batches: 0, dryRun: !o.apply };
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
    const writable = chunk.filter((r) => ids.get(r.number));
    for (const r of chunk) if (!ids.get(r.number)) res.failed.push(r.number);
    const done = writable.length ? await mutate(client, writable, ids, have, wait) : [];
    for (const r of writable) if (!done.includes(r.number)) res.failed.push(r.number);
    const ok = writable.filter((r) => done.includes(r.number));
    if (ok.length) {
      const at = new Date().toISOString();
      db.exec("BEGIN");
      for (const r of ok) {
        db.prepare("INSERT INTO main.stages (repo, number, stage, at, actor, note) VALUES (?, ?, 'labeled', ?, 'labels', ?)")
          .run(repo, r.number, at, `added: ${r.add.join(", ")}`);
      }
      audit(db, o.login ?? "cli", "labels-apply", repo, { run: o.runId, items: ok.map((r) => r.number), labels: ok.reduce((n, r) => n + r.add.length, 0) });
      db.exec("COMMIT");
      res.labeled += ok.length;
    }
    res.batches++;
    log(`${repo}: batch ${res.batches}: labelled ${ok.length} of ${chunk.length}`);
    const minMs = (chunk.length * 60_000) / WRITES_PER_MIN;
    const spent = Date.now() - started;
    if (spent < minMs && i + BATCH < todo.length) await wait(minMs - spent);
  }
  return res;
}

async function nodeIds(client: Querier, repo: string, numbers: number[], wait: Wait): Promise<Map<number, string | null>> {
  const out = new Map<number, string | null>();
  for (let i = 0; i < numbers.length; i += NODE_LOOKUP) {
    const part = numbers.slice(i, i + NODE_LOOKUP);
    const q = `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) {
      ${part.map((n) => `n${n}: issueOrPullRequest(number: ${n}) { ... on Labelable { id } }`).join("\n")} } }`;
    const d = await retrying(() => client.query(q, { owner: ORG, name: repo }), wait);
    for (const n of part) out.set(n, d.repository?.[`n${n}`]?.id ?? null);
  }
  return out;
}

// Returns the numbers whose mutation succeeded. A failed batch is retried item by item.
async function mutate(client: Querier, rows: PlanRow[], ids: Map<number, string | null>, have: Repo, wait: Wait): Promise<number[]> {
  const run = async (part: PlanRow[]): Promise<number[]> => {
    const vars: Record<string, unknown> = {};
    const decl: string[] = [];
    const body = part.map((r, k) => {
      vars[`i${k}`] = ids.get(r.number);
      vars[`l${k}`] = r.add.map((a) => have.labels.get(a.toLowerCase()));
      decl.push(`$i${k}: ID!`, `$l${k}: [ID!]!`);
      return `m${k}: addLabelsToLabelable(input: {labelableId: $i${k}, labelIds: $l${k}}) { clientMutationId }`;
    });
    const d = await retrying(() => client.query(`mutation(${decl.join(", ")}) { ${body.join("\n")} }`, vars), wait);
    return part.filter((_, k) => d && d[`m${k}`] !== null && d[`m${k}`] !== undefined).map((r) => r.number);
  };
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
