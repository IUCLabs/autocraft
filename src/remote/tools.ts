// The per-lease tools of a remote call (src/remote/protocol.ts ROUTES.tool and ROUTES.mcp): the item tools over the
// snapshot, the repo's reference documentation and the `check` build tool, each served only to a call whose bundle lists
// its server. The dashboard runs them; `check` is relayed to the job process that holds the call's CheckTool.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { CHECK_SERVER } from "../checktool/bridge.ts";
import { TOOL as CHECK_TOOL } from "../checktool/server/tool.ts";
import { fixupDir, GIT_ENV, gitDirEnv, HARDENING } from "../fixup/git.ts";
import { ITEM_SERVER } from "../itemtools/index.ts";
import { callTool as itemTool, openDb, TOOLS as ITEM_TOOLS, type ToolResult } from "../itemtools/server/tools.ts";
import { snapshotFile } from "../itemtools/snapshot.ts";
import { MAX_AROUND, MAX_RESULTS, referenceAround, referenceSearch, type Passage, type SearchOptions } from "../reference-search.ts";
import { diffCacheDir } from "../review/diff.ts";
import { REFERENCE_SERVER } from "./bundle.ts";
import { liveLease } from "./calls.ts";
import { relayCheck } from "./check-relay.ts";
import type { Mount, TaskBundle } from "./protocol.ts";

export type { ToolResult };

/** Reference passages one lease may read in all. */
export const PASSAGES_PER_LEASE = 60;
/** Options of the reference search (tests give an embedder and an index file). */
export const referenceOptions: SearchOptions = {};

const REFERENCE_TOOLS = [
  {
    name: "reference_search",
    description: "Searches the reference documentation of the repo's original application. Returns passages (id, page title, text), best match first. Read it to understand how the original behaves; never quote, cite or name it in your answer. The number of passages per call is limited in all.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["query"],
      properties: {
        query: { type: "string", description: "What to look for, in plain words." },
        limit: { type: "integer", description: `At most this many passages (default 5, max ${MAX_RESULTS}).` },
      },
    },
  },
  {
    name: "reference_around",
    description: "The passages before and after one passage on the same page, in page order, to read past a search result.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["passage"],
      properties: {
        passage: { type: "integer", description: "A passage id from reference_search." },
        before: { type: "integer", description: `Passages before it (default 1, max ${MAX_AROUND}).` },
        after: { type: "integer", description: `Passages after it (default 1, max ${MAX_AROUND}).` },
      },
    },
  },
];

/** The tool definitions of each task server, as tools/list returns them. */
export const TASK_TOOLS: Record<string, readonly unknown[]> = { [ITEM_SERVER]: ITEM_TOOLS, [CHECK_SERVER]: [CHECK_TOOL], [REFERENCE_SERVER]: REFERENCE_TOOLS };

export type TaskLease = { id: number; runId: number | null; login: string; servers: string[]; mounts: Mount[]; referenceRepo: string | null };

/** The live lease of a secret with what its tools need from the call, or null. */
export function taskLease(db: DatabaseSync, secret: string | undefined): TaskLease | null {
  const l = liveLease(db, secret);
  if (!l) return null;
  const r = db.prepare("SELECT bundle, reference_repo FROM main.remote_calls WHERE id = ?").get(l.id) as { bundle: string; reference_repo: string | null };
  const b = JSON.parse(r.bundle) as Omit<TaskBundle, "callId">;
  return { id: l.id, runId: l.runId, login: l.login, servers: b.mcpServers, mounts: b.mounts, referenceRepo: r.reference_repo };
}

class BadArgs extends Error {}

const int = (o: Record<string, unknown>, k: string, dflt: number): number => {
  const v = o[k];
  if (v === undefined) return dflt;
  if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 1e9) throw new BadArgs(`"${k}" must be a non-negative integer`);
  return v as number;
};

function object(raw: unknown, allowed: string[]): Record<string, unknown> {
  const o = raw ?? {};
  if (typeof o !== "object" || Array.isArray(o)) throw new BadArgs("arguments must be an object");
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new BadArgs(`unknown argument "${k}"`);
  return o as Record<string, unknown>;
}

const passageText = (p: Passage): string => `passage ${p.id}: ${p.title} (${p.page})\n${p.text}`;

/** Passages promised to calls still searching, per lease, so parallel calls cannot together exceed the allowance. */
const reserved = new Map<string, number>();

/** Serves reference passages within the lease's allowance and records each one. */
async function reference(db: DatabaseSync, lease: TaskLease, name: string, raw: unknown): Promise<ToolResult> {
  const repo = lease.referenceRepo;
  if (!repo) return { text: "this call has no reference documentation", isError: true };
  const used = (db.prepare("SELECT COUNT(*) AS n FROM main.remote_passages WHERE call_id = ? AND run_id IS ?").get(lease.id, lease.runId) as { n: number }).n;
  const key = `${lease.id}:${lease.runId}`;
  const left = PASSAGES_PER_LEASE - Number(used) - (reserved.get(key) ?? 0);
  if (left <= 0) return { text: `refused: the ${PASSAGES_PER_LEASE} reference passages of this call are used up; answer with what you know`, isError: true };
  // Reserve before the first await; the part not served is released in `finally`.
  reserved.set(key, (reserved.get(key) ?? 0) + left);
  let served: Passage[] = [];
  let found: Passage[] = [];
  try {
    if (name === "reference_search") {
      const a = object(raw, ["query", "limit"]);
      if (typeof a.query !== "string" || !a.query.trim() || a.query.length > 500) throw new BadArgs('"query" must be a string of at most 500 characters');
      found = await referenceSearch(repo, a.query, Math.min(int(a, "limit", 5), MAX_RESULTS), referenceOptions);
    } else {
      const a = object(raw, ["passage", "before", "after"]);
      if (a.passage === undefined) throw new BadArgs('missing argument "passage"');
      found = referenceAround(repo, int(a, "passage", 0), int(a, "before", 1), int(a, "after", 1), referenceOptions);
    }
    served = found.slice(0, left);
    const now = Date.now();
    const ins = db.prepare("INSERT INTO main.remote_passages (call_id, run_id, user_login, repo, passage_id, page, at) VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (const p of served) ins.run(lease.id, lease.runId, lease.login, repo, p.id, p.page, now);
  } finally {
    const rest = (reserved.get(key) ?? 0) - left;
    if (rest > 0) reserved.set(key, rest);
    else reserved.delete(key);
  }
  if (!served.length) return { text: name === "reference_search" ? "No passage matches." : "No passage next to it." };
  const cut = served.length < found.length ? `\n\n[${found.length - served.length} more passages withheld: the ${PASSAGES_PER_LEASE} passages of this call are used up]` : "";
  return { text: served.map(passageText).join("\n\n") + cut };
}

function items(name: string, raw: unknown): ToolResult {
  let db: DatabaseSync;
  try {
    db = openDb(snapshotFile());
  } catch {
    return { text: "the item tools are not available right now", isError: true };
  }
  try {
    return itemTool(db, { db: snapshotFile(), diffs: diffCacheDir() }, name, raw);
  } finally {
    db.close();
  }
}

/**
 * Runs one tool of `server` for the lease, which must list the server. Bad arguments and refusals come back as an error
 * result. `check` waits for the job process: `tick` is called about every 15 s meanwhile, and `signal` ends the wait.
 */
export async function callTaskTool(db: DatabaseSync, lease: TaskLease, secret: string, server: string, name: unknown, raw: unknown, opts: { signal?: AbortSignal; tick?: () => void } = {}): Promise<ToolResult> {
  const tools = TASK_TOOLS[server] as { name: string }[] | undefined;
  if (!tools || !lease.servers.includes(server)) return { text: `this call has no ${server} tools`, isError: true };
  if (typeof name !== "string" || !tools.some((t) => t.name === name)) return { text: `unknown tool ${JSON.stringify(name)}`, isError: true };
  try {
    if (server === ITEM_SERVER) return items(name, raw);
    if (server === REFERENCE_SERVER) return await reference(db, lease, name, raw);
    return await relayCheck(db, { id: lease.id, runId: lease.runId }, raw, { live: () => liveLease(db, secret)?.id === lease.id, ...opts });
  } catch (e) {
    if (e instanceof BadArgs) return { text: e.message, isError: true };
    console.error(`task tool ${server}/${name}: ${(e as Error).stack ?? e}`);
    return { text: "the tool failed; the error is logged", isError: true };
  }
}

/**
 * `git archive` of a tarball mount the lease's bundle lists, from our clone of the repo: a running process whose stdout is
 * the tar stream, or null when the bundle has no such mount or the clone lacks the commit. Instruction files stay in; the helper removes them.
 */
export function archiveOf(lease: TaskLease, repo: string, sha: string): ChildProcess | null {
  if (!lease.mounts.some((m) => m.kind === "tarball" && m.repo === repo && m.sha === sha)) return null;
  const env = { ...process.env, ...GIT_ENV, ...gitDirEnv(join(fixupDir(), repo)) };
  if (spawnSync("git", [...HARDENING, "cat-file", "-e", `${sha}^{commit}`], { env, stdio: "ignore" }).status !== 0) return null;
  return spawn("git", [...HARDENING, "archive", "--format=tar", sha], { env, stdio: ["ignore", "pipe", "ignore"] });
}
