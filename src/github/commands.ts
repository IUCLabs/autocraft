// Commands to the GitHub App in a GitHub comment. Someone who may use Queue items on the repo writes, on a line of its own,
//
//   @<app-slug> merge queue            (also merge-queue, mergequeue; optional weight: `@<app-slug> merge queue 8`)
//
// on a pull request or an issue, and the item goes into the merge queue as "Queue items" on the Queue page puts it there
// (queueAdd: a PR is pre-approved at its current head and fast-tracked; an issue is fast-tracked and its one closing PR queued).
// The app answers in the same thread with the outcome.
//
// The webhook keeps only the fields of github_commands, never the comment's text, and nothing of it reaches a prompt. The runner
// carries the command out: the commenter must have an AutoCraft login with the GitHub id bound to it, and then queueAdd applies the
// same rule as for Queue items (src/settlers.ts: an operator with write access on the repo, or a maintainer who settles decisions
// there), with the write permission read from GitHub now. A commenter without an AutoCraft login, or whose GitHub id is not the
// bound one, gets no answer, so a stranger cannot make the app write. The answer is the only write and goes through write.ts.
import type { DatabaseSync } from "node:sqlite";
import { getAccess, LOGIN } from "../access.ts";
import type { Role } from "../dash/types.ts";
import { guardRepo } from "../core/guard.ts";
import { audit } from "../dash/audit.ts";
import { fastPositions } from "../fasttrack.ts";
import { exec as defaultExec, type Exec } from "../fixup/git.ts";
import type { Querier } from "../mirror.ts";
import { ghComment, WritePacedError } from "./write.ts";

/** Comments read for a command: GitHub caps a body at 65536 characters. */
const BODY_MAX = 65_536;
/** A command not carried out before this long has passed is dropped unanswered (the runner was down, or GitHub could not tell the permission). */
const EXPIRE_MS = 3600_000;
/** A command whose permission read GitHub could not settle is tried again after this long. */
const RETRY_MS = 60_000;
const AUDIT_LOGIN = "github-command";

export type Command = { command: "merge-queue"; weight: number | null };

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The command in a comment addressed to the app, or null. The command is a line of its own: `@<slug> merge queue`, with an
 * optional weight (`8` or `weight 8`). Quoted lines (`> ...`) and fenced code are skipped, so quoting a command repeats nothing.
 * A fence closes as CommonMark closes it: the opening character, at least as many of it, and nothing after but spaces.
 */
export function parseCommand(body: unknown, slug: string): Command | null {
  if (typeof body !== "string" || !slug) return null;
  const re = new RegExp(`^@${escape(slug)}(?:\\[bot\\])?[\\s,:]+merge[-\\s]?queue(?:\\s+(?:weight\\s+)?(\\d{1,2}))?\\s*[.!]?$`, "i");
  let fence: { ch: string; len: number } | null = null;
  for (const raw of body.slice(0, BODY_MAX).split(/\r?\n/)) {
    const line = raw.trim();
    const f = /^(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (f && f[0] === fence.ch && f.length >= fence.len && line.slice(f.length).trim() === "") fence = null;
      continue;
    }
    if (f) { fence = { ch: f[0]!, len: f.length }; continue; }
    const m = re.exec(line);
    if (m) return { command: "merge-queue", weight: m[1] === undefined ? null : Number(m[1]) };
  }
  return null;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const posInt = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : null);

/**
 * Queues the command of a new `issue_comment` in a tracked repo (`repo`, as webhooks.ts resolved it). A redelivery of the same
 * comment adds nothing. Comments by bots and apps are left alone. Returns true when a command was queued.
 */
export function queueCommand(db: DatabaseSync, repo: string, event: string, payload: unknown, slug: string | null | undefined, now: Date = new Date()): boolean {
  if (event !== "issue_comment" || !slug) return false;
  const p = obj(payload);
  if (p.action !== "created") return false;
  const comment = obj(p.comment), user = obj(comment.user), issue = obj(p.issue);
  if (user.type !== "User" || comment.performed_via_github_app) return false;
  const login = typeof user.login === "string" && LOGIN.test(user.login) ? user.login : null;
  const githubId = posInt(user.id), commentId = posInt(comment.id), number = posInt(issue.number);
  if (!login || !githubId || !commentId || !number) return false;
  const cmd = parseCommand(comment.body, slug);
  if (!cmd) return false;
  const r = db.prepare(`INSERT OR IGNORE INTO main.github_commands (comment_id, repo, number, pr, command, weight, login, github_id, requested_at, state)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued')`)
    .run(commentId, repo, number, issue.pull_request ? 1 : 0, cmd.command, cmd.weight, login, githubId, now.toISOString());
  return r.changes > 0;
}

type Row = { comment_id: number; repo: string; number: number; pr: number; command: string; weight: number | null; login: string; github_id: number; requested_at: string; state: string; result: string | null };

/** What carries out a queued merge-queue command: the Queue page's queueAdd, as the commenter. `canWrite`: GitHub's answer for `repo`, read just before. Injectable for tests. */
export type QueueFn = (db: DatabaseSync, o: { login: string; role: Role; canWrite: boolean; repo: string; item: string; weight: number | null }) => Promise<string>;

type QueuePage = typeof import("../dash/api/queue-page.ts");

/** queueAdd from a module loaded beforehand, so nothing but the handler's own checks runs between the freshness check and its write. */
const queueVia = ({ queueAdd }: QueuePage): QueueFn => async (db, o) => {
  // The permission read covers the item's repo only; any other repo counts as no access.
  const has = async (repo: string): Promise<boolean> => repo === o.repo && o.canWrite;
  const user = { login: o.login, role: o.role, canWrite: has, canRead: has };
  const req = { method: "POST" as const, path: "/webhooks/github", params: {}, query: new URLSearchParams(), form: new URLSearchParams(), json: { item: o.item, ...(o.weight === null ? {} : { weight: o.weight }) }, user, csrf: "", nonce: "" };
  return (await queueAdd(db, req, "github")).label;
};

export type CommandDeps = {
  /** Reads the commenter's permission on the repo from GitHub. */
  querier: Querier;
  /** Runs `gh` for the answer. */
  exec?: Exec;
  queue?: QueueFn;
  /** Reads the live permission (default: the conversation cards' read, src/conversations/act.ts). */
  permission?: (q: Querier, repo: string, login: string) => Promise<"ok" | "no" | "transient">;
  now?: () => Date;
  log?: (l: string) => void;
  limit?: number;
};

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim().slice(0, 300).replace(/[.\s]+$/, "");
const refOf = (r: { repo: string; number: number }): string => `${r.repo}#${r.number}`;

function settle(db: DatabaseSync, r: Row, state: "done" | "refused" | "ignored" | "expired", result: string | null, at: Date): void {
  db.prepare("UPDATE main.github_commands SET state = ?, result = ?, done_at = ? WHERE comment_id = ?").run(state, result, at.toISOString(), r.comment_id);
  audit(db, state === "ignored" || state === "expired" ? AUDIT_LOGIN : r.login, "github-command", refOf(r), { comment: r.comment_id, command: r.command, by: r.login, state, ...(result ? { result } : {}) });
}

/**
 * Decides one queued command and carries it out. Who may queue is not decided here: queueAdd applies the rule of every person-started write
 * (settleRefusal in src/settlers.ts) to the commenter's current role and the write permission read from GitHub now. This only settles what a
 * comment adds: who the commenter is. Returns false when GitHub could not tell the permission: the row stays queued.
 */
async function carryOut(db: DatabaseSync, r: Row, deps: CommandDeps, now: Date, qp: QueuePage): Promise<"settled" | "retry" | "wait"> {
  const access = getAccess(db, r.login);
  const bound = (db.prepare("SELECT github_id FROM main.access WHERE login = ?").get(r.login) as { github_id: number | null } | undefined)?.github_id ?? null;
  // Not someone AutoCraft knows (no login, or the login now belongs to another GitHub account): no answer.
  if (!access || (bound !== null && Number(bound) !== r.github_id)) { settle(db, r, "ignored", null, now); return "settled"; }
  if (bound === null) { settle(db, r, "refused", "sign in to the AutoCraft dashboard once first, so your GitHub account is bound to your login", now); return "settled"; }
  const permission = deps.permission ?? (await import("../conversations/act.ts")).liveWrite;
  const p = await permission(deps.querier, r.repo, r.login).catch(() => "transient" as const);
  if (p === "transient") return "retry";
  // The permission read waited on GitHub: the hour may have run out meanwhile, and the outcome is recorded at this time.
  now = (deps.now ?? (() => new Date()))();
  if (now.getTime() - Date.parse(r.requested_at) >= EXPIRE_MS) { settle(db, r, "expired", null, now); return "settled"; }
  // Again after the permission read: a read may have been written meanwhile. The mirror never goes back to a read that started
  // earlier (writePage), so an item that passes here keeps a read from after the comment until queueAdd's pre-approval reads it.
  if (waitsForRead(db, r, now, qp)) return "wait";
  try {
    const label = await (deps.queue ?? queueVia(qp))(db, { login: r.login, role: access.role, canWrite: p === "ok", repo: r.repo, item: refOf(r), weight: r.weight });
    const f = fastPositions(db).get(refOf(r));
    settle(db, r, "done", `${oneLine(label)}.${f ? ` Fast-tracked with weight ${f.weight}, ${f.position} of ${f.of}.` : ""}`, now);
  } catch (e) {
    settle(db, r, "refused", oneLine(String((e as Error)?.message ?? e)) || "it could not be queued", now);
  }
  return "settled";
}

/**
 * True while an item the command may pre-approve has no read from GitHub since the comment: the item, and for an issue the open PRs
 * that close it (queueAdd queues the sole one). The read is the webhook's re-read, or the poll after a failed one; a request row
 * that is gone proves nothing, since a failed re-read drops it too. It must have started strictly after the comment: `synced_at` is
 * cut to the second, so one in the same instant may have started before it. For each stale item with no read queued it queues one,
 * at most once a minute (tried_at), so the command does not wait for a poll that may never read it again.
 */
function waitsForRead(db: DatabaseSync, r: Row, now: Date, qp: QueuePage): boolean {
  const readAt = db.prepare("SELECT synced_at FROM main.item_reads WHERE repo = ? AND number = ?");
  const stale = [r.number, ...(r.pr ? [] : qp.openPrsClosing(db, r.repo, r.number))].filter((n) => {
    const read = (readAt.get(r.repo, n) as { synced_at: string } | undefined)?.synced_at;
    return !read || Date.parse(read) <= Date.parse(r.requested_at);
  });
  if (!stale.length) return false;
  const ask = stale.filter((n) => !db.prepare("SELECT 1 FROM main.sync_requests WHERE repo = ? AND number = ?").get(r.repo, n));
  for (const n of ask) {
    db.prepare("INSERT INTO main.sync_requests (repo, number, event, requested_at) VALUES (?, ?, 'issue_comment', ?) ON CONFLICT (repo, number) DO NOTHING")
      .run(r.repo, n, now.toISOString().replace(/\.\d+Z$/, "Z"));
  }
  if (ask.length) db.prepare("UPDATE main.github_commands SET tried_at = ? WHERE comment_id = ?").run(now.toISOString(), r.comment_id);
  return true;
}

/** The answer posted on GitHub for a carried-out command. */
export function answerText(r: { login: string; state: string; result: string | null }): string {
  return r.state === "done" ? `@${r.login} ${r.result}` : `@${r.login} Not added to the merge queue: ${r.result}.`;
}

/** Posts the answer. A paced write leaves it for the next drain; any other failure is recorded (write.ts audits it) and not retried. */
async function answer(db: DatabaseSync, r: Row, deps: CommandDeps): Promise<"posted" | "failed" | "paced"> {
  const g = guardRepo(db, r.repo, null, { operator: r.login }, undefined, r.login);
  let reply: "posted" | "failed";
  if ("refused" in g) {
    deps.log?.(`github command ${refOf(r)}: no answer: ${g.refused}`);
    reply = "failed";
  } else {
    try {
      const out = await ghComment({ db, login: r.login }, g, deps.exec ?? defaultExec, "github-command-reply", { repo: r.repo, number: r.number, pr: r.pr === 1 }, { by: "fixed-operator" }, answerText(r), { comment: r.comment_id, command: r.command });
      reply = out.code === 0 ? "posted" : "failed";
      if (out.code !== 0) deps.log?.(`github command ${refOf(r)}: the answer failed: ${oneLine(out.stderr || out.stdout)}`);
    } catch (e) {
      if (e instanceof WritePacedError) return "paced";
      deps.log?.(`github command ${refOf(r)}: the answer failed: ${oneLine(String((e as Error)?.message ?? e))}`);
      reply = "failed";
    }
  }
  db.prepare("UPDATE main.github_commands SET reply = ? WHERE comment_id = ?").run(reply, r.comment_id);
  return reply;
}

/**
 * Carries out the queued commands, oldest first, and posts their answers. Run after the webhook's re-reads, so the item is in the
 * mirror at its current head. Returns how many commands were settled.
 */
export async function drainCommands(db: DatabaseSync, deps: CommandDeps): Promise<number> {
  const clock = deps.now ?? (() => new Date());
  const t0 = clock();
  // Every waiting row is read (an hour's commands at most): rows that wait for a re-read or a retry are passed over without
  // a GitHub call, so they never keep a newer command out. `limit` bounds the rows that call GitHub in one drain.
  const rows = db.prepare(`SELECT comment_id, repo, number, pr, command, weight, login, github_id, requested_at, state, result FROM main.github_commands
    WHERE (state = 'queued' AND (tried_at IS NULL OR tried_at <= ?)) OR (state IN ('done', 'refused') AND reply IS NULL) ORDER BY requested_at`)
    .all(new Date(t0.getTime() - RETRY_MS).toISOString()) as Row[];
  const qp = await import("../dash/api/queue-page.ts");
  let settled = 0, calls = 0;
  for (const r0 of rows) {
    if (calls >= (deps.limit ?? 10)) break;
    const now = clock();
    let r = r0;
    if (r.state === "queued") {
      if (now.getTime() - Date.parse(r.requested_at) >= EXPIRE_MS) { settle(db, r, "expired", null, now); continue; }
      if (r.command !== "merge-queue") { settle(db, r, "ignored", null, now); continue; }
      // No GitHub call while an item waits for a read since the comment (see waitsForRead).
      if (waitsForRead(db, r, now, qp)) continue;
      calls++;
      const out = await carryOut(db, r, deps, now, qp);
      if (out === "wait") continue;
      if (out === "retry") {
        // GitHub could not tell the permission: retried after RETRY_MS; the expiry still counts from requested_at.
        db.prepare("UPDATE main.github_commands SET tried_at = ? WHERE comment_id = ?").run(now.toISOString(), r.comment_id);
        continue;
      }
      settled++;
      r = db.prepare("SELECT comment_id, repo, number, pr, command, weight, login, github_id, requested_at, state, result FROM main.github_commands WHERE comment_id = ?").get(r.comment_id) as Row;
      if (r.state !== "done" && r.state !== "refused") continue;
    } else calls++;
    if ((await answer(db, r, deps)) === "paced") break;
  }
  return settled;
}
