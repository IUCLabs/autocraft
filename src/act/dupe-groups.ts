// Act for duplicate group decisions answered "use this answer" or "keep #N instead": post the
// exact comments stored with the decision (src/dupes/texts.ts) and close the members it closes.
// Each write is recorded in dupe_group_posts right after it happens, so a retry or a crash
// midway never repeats a comment or a close. A member that closed, merged or moved on its own
// is skipped; one whose head moved waits for a later run.
import type { DatabaseSync } from "node:sqlite";
import { audit } from "../dash/audit.ts";
import { inPilot } from "../pilot.ts";

const ACTOR = "act";

export type GroupLive = { id: string; type: "Issue" | "PullRequest"; state: string; head: string | null };
export type GroupIo = {
  live(number: number): Promise<GroupLive | null>;
  /** Returns the comment's URL. */
  comment(live: GroupLive, body: string): Promise<string>;
  close(live: GroupLive): Promise<void>;
};
export type GroupRun = {
  repo: string; io: GroupIo; at: () => string; log: (line: string) => void;
  /** Writes this run may still do under the step's limit. */
  left: () => number;
  handled: () => void;
  dryRun: boolean;
};
export type GroupResult = { done: string[]; skipped: { ref: string; reason: string }[]; failed: { ref: string; reason: string }[] };

type Item = { number: number; kind: string; role: string; comment: string | null; detail: string | null };
type Decision = { id: string; answer: string };

/** Answered group decisions of the repo whose roles are written (applyDuplicateAnswers ran) and that are not applied yet. */
export function groupDecisionsToAct(db: DatabaseSync, repo: string): Decision[] {
  return db.prepare(`SELECT d.id, d.answer FROM decisions d JOIN dupe_groups g ON g.decision_id = d.id
    WHERE d.kind = 'duplicate' AND d.repo = ? AND d.answer IS NOT NULL AND d.answer <> 'distinct' AND d.applied_at IS NULL
      AND g.applied_answer = d.answer AND d.answered_by IN (SELECT login FROM access WHERE role = 'operator') ORDER BY d.answered_at`).all(repo) as Decision[];
}

const carryOf = (detail: string | null): string[] => {
  try {
    const v = (JSON.parse(detail ?? "null") as { carry?: unknown } | null)?.carry;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
};

export async function actOnGroups(db: DatabaseSync, run: GroupRun): Promise<GroupResult> {
  const res: GroupResult = { done: [], skipped: [], failed: [] };
  const posted = db.prepare("SELECT 1 FROM dupe_group_posts WHERE decision_id = ? AND number = ? AND step = ?");
  const record = (id: string, n: number, step: string, url: string | null) =>
    db.prepare("INSERT OR IGNORE INTO dupe_group_posts (decision_id, number, step, url, at) VALUES (?, ?, ?, ?, ?)").run(id, n, step, url, run.at());
  const ref = (n: number) => `${run.repo}#${n}`;

  for (const dec of groupDecisionsToAct(db, run.repo)) {
    const items = db.prepare("SELECT number, kind, role, comment, detail FROM dupe_group_items WHERE decision_id = ? ORDER BY number").all(dec.id) as Item[];
    const closers = items.filter((i) => i.role === "close" && inPilot(db, run.repo, i.number));
    const details = items.find((i) => i.role === "keep" && i.kind === "issue" && i.comment && inPilot(db, run.repo, i.number));
    if (run.dryRun) {
      if (details && !posted.get(dec.id, details.number, "details")) run.log(`  would post the details comment on ${ref(details.number)} (${dec.id})`);
      for (const c of closers) if (!posted.get(dec.id, c.number, "close")) run.log(`  would comment and close ${ref(c.number)} (${dec.id})`);
      continue;
    }
    const skip = (n: number, step: string, reason: string) => {
      record(dec.id, n, step, null);
      audit(db, ACTOR, "act-skip", ref(n), { decision: dec.id, reason });
      res.skipped.push({ ref: ref(n), reason });
      run.log(`  ${ref(n)}: skipped: ${reason}`);
    };
    try {
      if (details && !posted.get(dec.id, details.number, "details")) {
        if (run.left() <= 0) return res;
        const live = await run.io.live(details.number);
        if (!live || live.state !== "OPEN") skip(details.number, "details", "the kept issue is gone or closed; no details comment");
        else {
          const url = await run.io.comment(live, details.comment!);
          record(dec.id, details.number, "details", url);
          audit(db, ACTOR, "act-comment", ref(details.number), { decision: dec.id, url, text: details.comment });
          run.handled();
          run.log(`  ${ref(details.number)}: posted the details comment`);
        }
      }
      for (const c of closers) {
        if (posted.get(dec.id, c.number, "close")) continue;
        if (run.left() <= 0) return res;
        const live = await run.io.live(c.number);
        if (!live) { skip(c.number, "close", "GitHub returned no such item"); continue; }
        if (live.state !== "OPEN") { skip(c.number, "close", `already ${live.state.toLowerCase()} on GitHub`); continue; }
        const known = (db.prepare("SELECT head_oid FROM items WHERE repo = ? AND number = ?").get(run.repo, c.number) as { head_oid: string | null } | undefined)?.head_oid;
        if (c.kind === "pr" && known && live.head !== known) {
          // Not recorded: the mirror catches up with the new head and a later run goes on.
          res.skipped.push({ ref: ref(c.number), reason: "the head moved since the comparison" });
          run.log(`  ${ref(c.number)}: skipped for now: the head moved since the comparison`);
          continue;
        }
        if (!c.comment) { res.failed.push({ ref: ref(c.number), reason: "the decision stores no comment for it" }); continue; }
        let url = (db.prepare("SELECT url FROM dupe_group_posts WHERE decision_id = ? AND number = ? AND step = 'comment'").get(dec.id, c.number) as { url: string | null } | undefined)?.url ?? null;
        if (url === null) {
          url = await run.io.comment(live, c.comment);
          record(dec.id, c.number, "comment", url);
          audit(db, ACTOR, "act-comment", ref(c.number), { decision: dec.id, url, text: c.comment });
        }
        await run.io.close(live);
        record(dec.id, c.number, "close", url);
        audit(db, ACTOR, "act-close", ref(c.number), { decision: dec.id, head: live.head });
        db.prepare("INSERT INTO stages (repo, number, stage, at, actor, note) VALUES (?, ?, 'closed', ?, ?, ?)").run(run.repo, c.number, run.at(), ACTOR, `closed after duplicate group decision ${dec.id}`);
        res.done.push(ref(c.number));
        run.handled();
        run.log(`  ${ref(c.number)}: commented and closed`);
      }
    } catch (e) {
      const why = (e as Error).message.replace(/\s+/g, " ").slice(0, 300);
      res.failed.push({ ref: dec.id, reason: why });
      run.log(`  ${dec.id}: failed: ${why}`);
      return res;
    }
    // Applied once every member to close has a close record and the details comment is settled.
    if (closers.every((c) => posted.get(dec.id, c.number, "close")) && (!details || posted.get(dec.id, details.number, "details"))) {
      db.prepare("UPDATE decisions SET applied_at = ? WHERE id = ? AND applied_at IS NULL").run(run.at(), dec.id);
      audit(db, ACTOR, "act-group-applied", dec.id, { answer: dec.answer });
      queueCarry(db, run.repo, dec.id, items, run.at());
    }
  }
  return res;
}

/** The kept PR gets a carry job when the PRs closed in its group name parts worth carrying over. */
function queueCarry(db: DatabaseSync, repo: string, id: string, items: Item[], at: string): void {
  const keep = items.find((i) => i.role === "keep" && i.kind === "pr");
  if (!keep || !items.some((i) => i.kind === "pr" && i.role === "close" && carryOf(i.detail).length)) return;
  db.prepare("INSERT OR IGNORE INTO dupe_carries (decision_id, repo, number, state, updated_at) VALUES (?, ?, ?, 'queued', ?)").run(id, repo, keep.number, at);
  audit(db, ACTOR, "carry-queued", `${repo}#${keep.number}`, { decision: id });
}
