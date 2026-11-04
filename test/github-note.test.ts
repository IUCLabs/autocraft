// Every text-posting wrapper in src/github/write.ts puts the note line first, then a blank line, then the text.
import { G, guarded } from "./guarded.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { connect } from "../src/db.ts";
import type { Note } from "../src/github/note.ts";
import { commentOn, createIssue, editReview, ghClosePr, ghComment, ghEditComment, ghOpenPr, postReview, type Writer } from "../src/github/write.ts";
import type { Querier } from "../src/mirror.ts";
import { SCRATCH } from "./scratch.ts";

const NOTES: [Note, string][] = [
  [{ by: "model", kind: "review", model: "claude-opus-5-5" }, "_AI-generated review (Opus 5.5). Not a maintainer decision._"],
  [{ by: "model", kind: "pull request", model: "claude-sonnet-5-5" }, "_AI-generated pull request (Sonnet 5.5). Not a maintainer decision._"],
  [{ by: "operator", model: "claude-opus-5-5" }, "_AI-generated reply (Opus 5.5)_"],
  [{ by: "operator", model: null }, "_AI-generated reply_"],
  [{ by: "fixed" }, "_Automated message. Not a maintainer decision._"],
  [{ by: "fixed-operator" }, "_Automated reply_"],
];

test("each posting wrapper sends the note as the first line and records the text as posted", async () => {
  const db = connect(join(mkdtempSync(join(SCRATCH, "ghnote-")), "t.db"));
  const w: Writer = { db, login: "t" };
  const item = { repo: "app", number: 7, id: "N7" };
  for (const [note, line] of NOTES) {
    const want = `${line}\n\nThe text.`;
    const vars: Record<string, unknown>[] = [];
    const q = { spent: 0, remaining: null, async query(_q: string, v: Record<string, unknown>) { vars.push(v); return { addComment: {}, addPullRequestReview: { pullRequestReview: { id: "R1" } } }; } } as Querier;
    await commentOn(w, G("app"), q, "act-comment", item, note, "The text.");
    await postReview(w, q, guarded("app", 7, "abc"), "N7", note, "The text.");
    await editReview(w, q, guarded("app", 7, "abc"), "R1", note, "The text.");
    assert.deepEqual(vars.map((v) => v.body), [want, want, want]);

    const calls: { args: string[]; input?: string }[] = [];
    const exec = async (_c: string, args: string[], o?: { input?: string }) => { calls.push({ args, input: o?.input }); return { code: 0, stdout: "https://github.com/storytold/app/issues/9\n", stderr: "" }; };
    await ghComment(w, G("app"), exec, "fixup-comment", { repo: "app", number: 7, pr: true }, note, "The text.");
    await ghEditComment(w, G("app"), exec, "fixup-comment-edit", { repo: "app", number: 7, commentId: "5" }, note, "The text.");
    await ghOpenPr(w, G("app"), exec, "batch-pr", { repo: "app", target: "app:b", base: "main", head: "me:b", title: "T", body: "The text." }, note);
    await createIssue(w, G("app"), exec, { repo: "app", target: "app#7", title: "T", body: "The text." }, note);
    assert.deepEqual(calls.map((c) => c.input), [want, want, want, want]);
    calls.length = 0;
    await ghClosePr(w, G("app"), exec, { repo: "app", number: 7 }, note, "The text.");
    assert.equal(calls[0]!.args[calls[0]!.args.indexOf("--comment") + 1], want);

    const texts = (db.prepare("SELECT details FROM audit").all() as { details: string }[]).map((r) => (JSON.parse(r.details) as { text?: string }).text).filter((t) => t !== undefined);
    assert.ok(texts.length === 6 && texts.every((t) => t!.startsWith(`${line}\n\n`)));
    db.exec("DELETE FROM audit");
  }
});
