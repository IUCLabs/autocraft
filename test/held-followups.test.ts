// "Merge #n and open a follow-up issue": the press holds the issue, the Act step opens it once after the PR merged and drops it when the PR closes unmerged.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { runAct } from "../src/act/index.ts";
import { doCard } from "../src/conversations/act.ts";
import { decisionStamp } from "../src/conversations/cards.ts";
import { HEAD_FACT, MERGE_OPTIONS, mergeDecisionId } from "../src/core/rules.ts";
import { ask, getDecision } from "../src/decisions.ts";
import type { Exec } from "../src/fixup/git.ts";
import { T0, world, type World } from "./world-db.ts";

let current: World | null = null;
afterEach(() => current?.close());

test("a follow-up issue on a Merge card is opened once after the merge and dropped when the PR closes unmerged", async () => {
  current = world().repo().pr(1).pr(2);
  const w = current;
  const created: string[] = [];
  const exec: Exec = async (cmd, args) => {
    if (cmd === "gh" && args[0] === "issue" && args[1] === "create") { created.push(args[args.indexOf("--title") + 1]!); return { code: 0, stdout: `https://github.com/storytold/app/issues/${100 + created.length}\n`, stderr: "" }; }
    throw new Error(`unexpected ${cmd} ${args.join(" ")}`);
  };
  const press = async (n: number) => {
    const id = mergeDecisionId("app", n, `sha${n}`);
    ask(w.db, [{ id, kind: "merge", repo: "app", number: n, question: "Merge this PR?", facts: [`${HEAD_FACT}sha${n}`], options: Object.values(MERGE_OPTIONS).map((x) => ({ ...x })), asked_by: "merge", asked_at: T0 }]);
    const params = { kind: "resolution", steps: [{ kind: "open_issue", repo: "app", title: `Follow-up of ${n}`, body: "The parser still drops the last line." }], settle: { kind: "answer", decision: id, option: "merge", stamp: decisionStamp(w.db, getDecision(w.db, id)!) } };
    const card = Number(w.db.prepare("INSERT INTO conversation_cards (turn_id, repo, number, kind, params, description) VALUES (0, 'app', ?, 'resolution', ?, 'merge and open an issue')").run(n, JSON.stringify(params)).lastInsertRowid);
    const r = await doCard(w.db, card, "op", { ...w.gh.actDeps(), exec } as never);
    assert.equal(r.card.state, "done", r.card.error ?? "");
    assert.equal(getDecision(w.db, id)!.answer, "merge");
  };
  await press(1);
  await press(2);
  assert.deepEqual(created, [], "nothing is opened at the press");
  const held = () => w.rows("SELECT number, state, issue_number, reason FROM held_followups ORDER BY number");
  assert.deepEqual(held().map((h) => h.state), ["held", "held"]);

  w.db.prepare("UPDATE items SET state = 'MERGED' WHERE repo = 'app' AND number = 1").run();
  w.db.prepare("UPDATE items SET state = 'CLOSED' WHERE repo = 'app' AND number = 2").run();
  for (let k = 0; k < 2; k++) await runAct(w.db, { repo: "app", dryRun: false }, () => {}, { ...w.gh.actDeps(), exec });

  assert.deepEqual(created, ["Follow-up of 1"], "opened once, after the merge");
  const [one, two] = held();
  assert.equal(one!.state, "filed");
  assert.ok(one!.issue_number);
  assert.equal(two!.state, "dropped");
  assert.match(String(two!.reason), /closed without merging/);
});
