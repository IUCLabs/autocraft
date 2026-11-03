// Act for duplicate group decisions answered "use this answer" or "keep #N instead": post the
// exact comments stored for the chosen option (src/dupes/texts.ts) and close the members it closes.
// Each write is recorded in dupe_group_posts right after it happens, so a retry or a crash
// midway never repeats a comment or a close. A member that closed, merged or moved on its own
// is skipped, and so is a whole decision whose answer or roles changed (undo, refresh) while the run went on.
import type { DatabaseSync } from "node:sqlite";
import { audit } from "../dash/audit.ts";
import { inPilot } from "../pilot.ts";
import { textsFor } from "../dupes/texts.ts";

const ACTOR = "act";
/** Failed writes on one member before it is recorded as skipped. */
export const MAX_FAILS = 3;

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

type Item = { number: number; kind: string; role: string; detail: string | null; head: string | null };
type Decision = { id: string; answer: string };

/** Answered group decisions of the repo whose roles are written (applyDuplicateAnswers ran) and that are not applied yet. */
export function groupDecisionsToAct(db: DatabaseSync, repo: string): Decision[] {
  return db.prepare(`SELECT d.id, d.answer FROM decisions d JOIN dupe_groups g ON g.decision_id = d.id
    WHERE d.kind = 'duplicate' AND d.repo = ? AND d.answer IS NOT NULL AND d.answer <> 'distinct' AND d.applied_at IS NULL
      AND g.applied_answer = d.answer AND d.answered_by IN (SELECT login FROM access WHERE role = 'operator') ORDER BY d.answered_at`).all(repo) as Decision[];
}

/** The decision's answer and the item's stored role are still what the run started from: an undo or a refresh in between changes them. */
function unchanged(db: DatabaseSync, dec: Decision, item: Item): boolean {
  return !!db.prepare(`SELECT 1 FROM decisions d JOIN dupe_groups g ON g.decision_id = d.id JOIN dupe_group_items gi ON gi.decision_id = d.id
    WHERE d.id = ? AND d.answer = ? AND d.applied_at IS NULL AND g.applied_answer = ? AND gi.number = ? AND gi.role = ?`).get(dec.id, dec.answer, dec.answer, item.number, item.role);
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

  decisions: for (const dec of groupDecisionsToAct(db, run.repo)) {
    const items = db.prepare("SELECT number, kind, role, detail, head FROM dupe_group_items WHERE decision_id = ? ORDER BY number").all(dec.id) as Item[];
    const texts = new Map(textsFor(db, dec.id, dec.answer).map((t) => [`${t.number}:${t.step}`, t.text]));
    const closers = items.filter((i) => i.role === "close" && inPilot(db, run.repo, i.number));
    const details = items.find((i) => i.role === "keep" && i.kind === "issue" && texts.has(`${i.number}:details`) && inPilot(db, run.repo, i.number));
    if (run.dryRun) {
      if (details && !posted.get(dec.id, details.number, "details")) run.log(`  would post the details comment on ${ref(details.number)} (${dec.id})`);
      for (const c of closers) if (!posted.get(dec.id, c.number, "close")) run.log(`  would comment and close ${ref(c.number)} (${dec.id})`);
      continue;
    }
    const skip = (n: number, step: string, reason: string, release = false) => {
      record(dec.id, n, step, null);
      if (release) {
        // Not closed by this decision: it stays open, is no longer held or settled by it, and the next comparison may ask about it again.
        db.prepare("UPDATE dupe_group_items SET role = 'stay', target = NULL, base_role = 'stay', base_target = NULL WHERE decision_id = ? AND number = ?").run(dec.id, n);
        record(dec.id, n, "released", null);
        audit(db, ACTOR, "duplicate-member-released", ref(n), { decision: dec.id, reason });
      }
      audit(db, ACTOR, "act-skip", ref(n), { decision: dec.id, reason });
      res.skipped.push({ ref: ref(n), reason });
      run.log(`  ${ref(n)}: skipped: ${reason}`);
    };
    const changed = (it: Item): boolean => {
      if (unchanged(db, dec, it)) return false;
      run.log(`  ${dec.id}: changed since the run started; left for the next run`);
      return true;
    };
    let cur: { item: Item; step: string } | null = null;
    try {
      if (closers.some((c) => !posted.get(dec.id, c.number, "close")) || (details && !posted.get(dec.id, details.number, "details"))) {
        // The kept items must still stand: a closed (unmerged) kept item makes the duplicates' comments wrong.
        for (const k of items.filter((i) => i.role === "keep")) {
          const live = await run.io.live(k.number);
          if (!live || (live.state !== "OPEN" && !(live.type === "PullRequest" && live.state === "MERGED"))) {
            // Nothing stays held by a decision that can no longer close anything: the members are released and the next comparison asks again.
            const reason = `the kept item ${ref(k.number)} is gone or closed`;
            for (const c of closers) if (!posted.get(dec.id, c.number, "close")) skip(c.number, "close", reason, true);
            db.prepare("UPDATE decisions SET applied_at = ? WHERE id = ? AND applied_at IS NULL").run(run.at(), dec.id);
            audit(db, ACTOR, "duplicate-group-ended", dec.id, { reason });
            run.log(`  ${dec.id}: ${reason}; group ended`);
            continue decisions;
          }
        }
      }
      if (details && !posted.get(dec.id, details.number, "details")) {
        if (run.left() <= 0) return res;
        cur = { item: details, step: "details" };
        if (changed(details)) continue decisions;
        const live = await run.io.live(details.number);
        if (!live || live.state !== "OPEN") skip(details.number, "details", "the kept issue is gone or closed; no details comment");
        else {
          if (changed(details)) continue decisions;
          const text = texts.get(`${details.number}:details`)!;
          const url = await run.io.comment(live, text);
          record(dec.id, details.number, "details", url);
          audit(db, ACTOR, "act-comment", ref(details.number), { decision: dec.id, url, text });
          run.handled();
          run.log(`  ${ref(details.number)}: posted the details comment`);
        }
      }
      for (const c of closers) {
        if (posted.get(dec.id, c.number, "close")) continue;
        if (run.left() <= 0) return res;
        cur = { item: c, step: "close" };
        if (changed(c)) continue decisions;
        const live = await run.io.live(c.number);
        if (!live) { skip(c.number, "close", "GitHub returned no such item"); continue; }
        if (live.state !== "OPEN") { skip(c.number, "close", `already ${live.state.toLowerCase()} on GitHub`); continue; }
        if (c.kind === "pr" && c.head && live.head !== c.head) { skip(c.number, "close", "the head moved since the comparison", true); continue; }
        if (c.kind === "issue" && c.head) {
          const now = (db.prepare("SELECT embed_hash FROM items WHERE repo = ? AND number = ?").get(run.repo, c.number) as { embed_hash: string | null } | undefined)?.embed_hash;
          if (now && now !== c.head) { skip(c.number, "close", "the text changed since the comparison", true); continue; }
        }
        const text = texts.get(`${c.number}:close`);
        if (!text) { skip(c.number, "close", "the decision stores no comment for this answer"); continue; }
        let url = (db.prepare("SELECT url FROM dupe_group_posts WHERE decision_id = ? AND number = ? AND step = 'comment'").get(dec.id, c.number) as { url: string | null } | undefined)?.url ?? null;
        if (url === null) {
          if (changed(c)) continue decisions;
          url = await run.io.comment(live, text);
          record(dec.id, c.number, "comment", url);
          audit(db, ACTOR, "act-comment", ref(c.number), { decision: dec.id, url, text });
        }
        if (changed(c)) continue decisions;
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
      res.failed.push({ ref: cur ? ref(cur.item.number) : dec.id, reason: why });
      run.log(`  ${dec.id}: failed: ${why}`);
      if (!cur) return res;
      // One permanent error (a locked issue, a 403) must not block every later group: after MAX_FAILS the member is skipped.
      db.prepare("INSERT INTO dupe_group_fails (decision_id, number, fails) VALUES (?, ?, 1) ON CONFLICT (decision_id, number) DO UPDATE SET fails = fails + 1").run(dec.id, cur.item.number);
      const n = (db.prepare("SELECT fails FROM dupe_group_fails WHERE decision_id = ? AND number = ?").get(dec.id, cur.item.number) as { fails: number }).fails;
      if (n < MAX_FAILS) return res;
      // A member whose comment is already public is settled, not released: re-asking would repeat the comment.
      const commented = !!db.prepare("SELECT 1 FROM dupe_group_posts WHERE decision_id = ? AND number = ? AND step = 'comment' AND url IS NOT NULL").get(dec.id, cur.item.number);
      skip(cur.item.number, cur.step, `${n} writes failed: ${why}`, cur.step === "close" && !commented);
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
  if (!keep || !items.some((i) => i.kind === "pr" && i.role === "close" && carryOf(i.detail).length && db.prepare("SELECT 1 FROM dupe_group_posts WHERE decision_id = ? AND number = ? AND step = 'close' AND url IS NOT NULL").get(id, i.number))) return;
  db.prepare("INSERT OR IGNORE INTO dupe_carries (decision_id, repo, number, state, updated_at) VALUES (?, ?, ?, 'queued', ?)").run(id, repo, keep.number, at);
  audit(db, ACTOR, "carry-queued", `${repo}#${keep.number}`, { decision: id });
}
