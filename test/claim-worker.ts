// Child process of claim-concurrent.test.ts: waits for the start time, then
// takes slots as fast as it can and prints how many it got.
import { connect } from "../src/db.ts";
import { tryStartClaudeRun } from "../src/agents/call.ts";

const [dbFile, startAt, tries] = process.argv.slice(2) as [string, string, string];
const db = connect(dbFile);
while (Date.now() < Number(startAt)) { /* spin until the shared start time */ }
let got = 0;
for (let i = 0; i < Number(tries); i++) {
  const c = tryStartClaudeRun(db, { promptId: "classify.haiku", promptVersion: "v", provider: "claude", model: "haiku", items: [], prompt: "p" });
  if ("runId" in c) got++;
}
console.log(got);
