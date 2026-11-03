# How the triage pipeline works

The pipeline sorts the craft apps' open issues and PRs (about 21,000), reviews and merges the PRs we want, and fixes clear bugs. Models read, sort and review. People answer the decisions that need judgement, on this dashboard.

## The flow

Each column is an actor. Rows run top to bottom in pipeline order. The heavy line is the automatic path: nothing on it waits for a person. Thin lines are side branches, and dashed lines are branches that wait for the operator (Decide, Duplicate?, Close this PR?, Merge?, Hold) or are rare. Cards in the GitHub writes column name the approval they need for that repo (Repos page) and stay within their daily limit.

```swimlane
pipeline
```

Sync, Embed, Duplicates, Classify, Priority and Decide cover the whole org. Label, Review, Fix, Fix-up, Verify, Merge and Act go one or a few repos at a time. The work rank orders the candidates of Decide, Review, Verify and Fix-up, highest first.

## Sync

Every issue, PR and comment of the tracked repos is mirrored into the local database every minute (one org-wide search for changes). Later stages plan from the mirror. The mirror can be minutes behind GitHub, so every stage that writes to GitHub or spends a model call first reads the item's live state (state, draft flag, head commit) in one batched query and skips what changed; the skipped items come back on a later pass. Automatic; no model.

Each run searches from 10 minutes before the newest `updatedAt` stored, and once an hour it also re-reads the 6 hours before it, because GitHub's search index can show an item late. An item whose stored row already matches GitHub is not written again. A window of one second with more than 1,000 matches cannot be read by search: the run logs a warning and lists every tracked repo for it instead, and no high-water mark moves until the run finishes. Once a day per tracked repo (the repo reconciled longest ago, one per run) the sync lists the repo's open issues and PRs. Mirror rows that are open here but not listed as open are read individually: closed or merged ones are updated, and deleted or transferred ones are marked CLOSED and recorded in the audit log as `item-gone`. Tracking a repo again clears its high-water mark, so the next sync reads it in full. Only the last 20 comments and 10 reviews of an item are mirrored.

## Embed

Each item gets a vector from its title and body. A new vector is made only when the text changes. Runs locally on this machine; no model quota and no limit.

## Duplicates

Finds open issues and PRs that describe the same bug or request as another open item, or one closed within the last year, in the same repo.

- **Candidates.** Nearest neighbours by vector (similarity 0.86 or more, at most 3 per item, same kind). A pair an operator already ruled on is not asked again.
- **Check.** Jev answers first (0.9 or more is a duplicate, 0.1 or less is distinct). Haiku settles the rest.
- **Groups.** Items joined by duplicate pairs form a group. The members of each kind (PRs, issues) are compared together in one call by the Compare duplicate groups step (`craft-auto dupe-compare`).
  - PRs: Opus, with read-only tools on a checkout of the default branch, gets each PR's title, body, linked issues and code diff; CI and review state are background, not rules. It picks the PR to keep and, for each other PR, says whether it is a duplicate, what it does better and which parts are worth carrying into the kept one.
  - Issues: Sonnet, without tools, gets all reports in one call. It picks the report to keep and lists what each other report adds (steps, versions, logs).
  - A PR is never closed as a duplicate of an issue; the kept PR is linked to the kept issue.
  - A closed or merged member wins without a call. A set of more than 10 members is compared in rounds of 10 whose winners meet.
  - A set is compared again only when a member's state, head commit or text changes. Live state is checked on GitHub before the calls; a set with a changed member waits for the next sync.
  - When the model gives no valid answer twice, the rule decides: the closed or merged one, else the one with a merged fix, else the one with 5 or more extra comments, else the older one. The decision says it was kept by rule and recommends nothing.
- **Decision.** One per group, asked once the group is compared: "Keep #A and close #B, #C as duplicates?" with Use this answer, Keep #N instead (up to three alternatives) and Not duplicates. The summary lists, per item, what it does better, what is worth carrying over or what it adds. Every `#number` in the decision links to the item page and to GitHub. Only an operator's answer counts. Open per-pair decisions of the group are superseded by it (audited); answered ones keep their effect.
- **Held out.** While the decision is open or answered Use this answer / Keep #N instead, the items it closes are left out of Decide, Review, Verify, Fix-up and Fix. "Not duplicates" releases them for good and stores every pair of the group as distinct.
- **Comments.** The exact texts are written when the decision is asked, one set per answer (Use this answer and each Keep #N instead), and shown under that answer, so the answer approves exactly the words it posts. The page sends a hash of the shown texts with the answer; a changed set is refused (409) and the page reloads. Each member to close gets "Closing as a duplicate of #A." and, for a PR with parts to carry over, a second line "Parts to carry over to #A: ..." naming the first two points. For issue groups the kept issue gets one comment, "Details from the closed duplicates:", with at most six bullets built from the points each closed report adds, each crediting its source (`- #n: ...`; links, HTML, cross-repo references and mentions removed). The kept PR's fallback suggestion (used when its branch can't be pushed to) is part of the set. No model writes these, and none is written after an answer.
- **Act.** In a repo approved for comments, Act posts the stored texts for an answered group (Use this answer or Keep #N instead) and closes the members, within the step's limit and pilot. Each write is recorded in `dupe_group_posts` right after it happens, so a crash or retry never repeats a comment or a close. Before closing, Act reads the kept items (a closed, unmerged one stops the decision) and each member on GitHub: one already closed or merged, a PR whose head differs from the head stored when the decision was asked, or an issue whose text changed is skipped and recorded; such a member (and one whose close failed three times) is released: its role becomes stay, it is no longer held or settled by the decision, and the next comparison may ask about it again. Roles and answer are re-read before every write, so an undo or refresh stops the decision. A member whose writes fail three times is skipped. Undo is refused once Act wrote to GitHub. The decision is applied when every member to close has been closed.
- **Carry-over.** When PRs closed in a group name parts worth carrying over, Act queues a job for the kept PR (`dupe_carries`). Fix-up works it with its take-fix rules: a model (sandboxed) writes a diff porting the listed parts, shown with the closed PRs' diffs; the patch check (Opus) must approve; the push to the PR's branch needs push approval and maintainer edits. Without them, in a repo approved for comments, the parts are posted on the kept PR as one comment instead. Two failed tries hold the job. Take-fix tries and stages of the PR are not touched.
- **Hand-off.** A close goes to Act. Confirmed duplicates raise the original's priority.

Models: Jev, Haiku (pair checks); Opus and Sonnet (group comparison). Daily limits: 2000 pairs for the check, 200 comparisons for the group comparison. Both honour the pilot list. Writes nothing to GitHub.

## Classify

Every open item gets one type label (bugfix, performance, missing feature, small extra, plugin candidate, infra) and two flags (security, needs decision).

- Jev first. Under 90 % sure, Haiku gives a second opinion.
- A type is settled when Jev is at 90 % or more, or Haiku agrees with Jev. Disagreements among the scope labels go to Decide.
- Other disagreements (for example bugfix against missing feature) go to the Sonnet referee, which applies the classification rules and says whether it is sure. A sure label settles the type, and a scope label then follows the normal scope path. An unsure answer leaves the label to a person. The referee has its own step and daily limit.
- Started by the operator for a full pass; the pipeline classifies new and changed items on its own. Daily limit 2000.

## Priority

Each open item gets a level from P0 to P4.

| Level | Meaning |
|---|---|
| P0 critical | Crash, data loss, security hole, broken build or install, unusable app |
| P1 high | A core feature is broken, or a regression |
| P2 normal | An ordinary bug, feature or change |
| P3 low | Cosmetic, wording, docs, nice-to-have |
| P4 backlog | Kept open but not worked on now: vague or wishlist requests, ideas without a clear ask, very large asks with little reach. Plugin candidates are P4. |

- Jev picks the level; under 90 % sure, Haiku decides. The security flag raises the level by one, up to P0.
- Reach (0 to 99) breaks ties inside a level: commenters, comments, linked PRs, confirmed duplicates, the security flag and age. No model. It is not shown.
- Models run again only when the item's text changes; reach is recomputed from the mirror on every pass.
- Unrated items count as P2. Daily limit 3000 items sent to Jev; raise it for the first pass over a new org.
- Fix skips P4 issues: no code is written for the backlog. Everywhere else P4 items come last. Review still reviews P4 PRs.

## Work rank

One key per open item decides what the pipeline works on next, for issues and PRs alike. No model; recomputed whenever the items, priorities or fix estimates change. Items are ordered by, in turn:

1. Level, P0 first.
2. Type: bugfix, performance, infra, missing feature, small extra, plugin candidate; not settled last.
3. Size, smaller first: S, M, L, XL.
4. Reach, higher first.

- The key is one integer, `(4 - level) * 10000 + type * 1000 + size * 100 + reach`, so every candidate list sorts by it.
- PR size comes from changed lines: up to 50 S, up to 300 M, up to 1,000 L, more XL. An issue counts as M until Fix triage estimates its size.
- Decide, Review, Fix, Fix-up, Verify and the merge queue all take the highest-ranked item first.
- When Review and Fix both have work, the one with the higher-ranked item starts first. Daily limits still cap both.
- The Work queue page lists every open item in rank order with its level, type, size and next step.

## Decide

Asks the operator for a scope call on open items that either carry the needs-decision flag (settled), or where Jev and Haiku chose different labels among missing feature, small extra and plugin candidate.

- Each decision has a question, up to four options, a recommendation, up to five facts and a 2 to 4 sentence Sonnet summary. Duplicate decisions carry the group comparison as their summary (see Duplicates); Merge? and Close? decisions show the stored review text at the PR's head (Sonnet's review and, when present, Opus's final review), written when the decision is asked and by the next Merge or Act run for open ones without a summary. No model call is made for those.
- An item with an open or answered scope decision is not asked again. Anyone signed in can comment and pick; only the operator's answer counts.

| Answer | Effect |
|---|---|
| `take` | In scope. PRs go to Review |
| `small-extra` | Keep in core, label "small extra" |
| `plugin` | Not for core. Keep open, label "plugin candidate" |
| `close` | Out of scope. Goes to Act |
| `need-info` | Ask how the reference app behaves, then decide again |

Model: Sonnet (summaries). Daily limit 100.

## Label

Writes each settled type label and flag to GitHub. No model.

- Only settled types are labelled. A label a person set is never changed: items with a different type label are skipped and reported.
- Needs the repo's **label approval**. Without it the stage only plans.
- Writes in batches, at most 60 a minute. A re-run skips items already labelled. Each batch first reads the live state of its items; an item that is no longer open is skipped, counted and its mirror row updated.
- An operator's `plugin` scope answer sets the plugin candidate type, also where the classifiers disagreed; the label goes through the same approval.

## Review

Code review of open, non-draft PRs whose settled type is bugfix, performance, missing feature, small extra or infra. A PR flagged needs-decision waits for a `take` or `small-extra` answer. A PR already reviewed at its current head is skipped; a push brings it back. Reads GitHub, writes nothing.

Two passes. Sonnet reviews first; Opus then reviews every PR Sonnet rated take or take-fix. Opus's verdict is the **final** one.

- **First pass.** Sonnet, no tools, one call per batch of related PRs (at most 15 PRs). PR text and diffs are quoted as untrusted data.
- **Input.** Title, body, size (S up to 50 changed lines, M up to 300, L above), CI and merge state, changed files, and the diff of code files. Tests and lockfiles are listed, not diffed.
- **Too large.** Over 1,500 changed code lines, or no diff from GitHub: held without a model call.

| Verdict | Meaning |
|---|---|
| take | Wanted, correct, nothing to change |
| take-fix | Wanted and nearly right; small mechanical fixes are listed |
| hold | Needs a person: unclear reference behaviour, design or scope choice, overlaps, too large |
| close | Wrong or broken beyond a small fix, not wanted, already done, or superseded |

The weaker of two duplicate PRs is held, never closed, until the better one merges. Daily limit 40 PRs.

### Second pass: Opus

Step `opus-review`, one PR per call, no tools, untrusted data quoted as in the first pass. Opus gets the full diff and Sonnet's verdict and fix list, and returns a verdict (take, take-fix, hold or close), a complete fix list for take-fix (it may keep, drop or add to Sonnet's), its reasons and `sure`. Highest work rank first; daily limit 40 PRs. Sonnet hold and close verdicts get no second pass. Before the calls, the candidates' live state and heads are read in one query; a PR that is closed, a draft or at a different head than selected is dropped and returns as a candidate on the next pass.

- **Final verdict.** Opus's for the head. Sonnet's when the skip list applies. While a Sonnet take or take-fix has neither, there is no final verdict yet and later stages wait (the queue shows `waiting-opus`).
- **Disagreement.** When Opus's verdict differs from Sonnet's (take and take-fix count as the same) and Opus is not sure, the PR is held for a person; the hold reason shows both reviews. Otherwise Opus's verdict stands without a person.
- **Skip list.** No Opus call when the whole diff is one of: docs, translations or comments only, under 20 changed lines in total (`*.md`, `docs/`, `*.ftl` and locale directories, or code files where every changed line is a comment or blank); dependency bumps only (lockfiles, and version-string changes in `Cargo.toml` or `package.json`) with green CI; test files only. The rule is code, not a model's opinion. The skip reason is stored with the review and shown on the Item page.
- **New push.** Sonnet reviews the new head as usual. Opus then reads only the changes from the head it reviewed last to the new head, with its earlier review as context. If GitHub's compare fails or the old head is not an ancestor (force push), it reads the full diff. The skip list is checked on the full diff.
- **Too large** for one call: held without a call.
- **Stored** per PR and head in `opus_reviews` (verdict, sure, reason, fixes, risks, mode full / delta / skipped, base head, skip reason). The `final_reviews` view joins both passes; every later stage reads it. Integration batches get no Opus review of their combined diff.

### Posting the final review

Step `review-post`, only in repos with **comment approval**; calls no model. For each open PR with an Opus review (a verdict, not a skip) and a public text at its current head that no review of ours describes yet, it posts one pull request review with event COMMENT (never an approval or a change request). PRs by the pipeline's own account, integration batch PRs, PRs held as duplicates and items outside the pilot are left out. Daily limit 40 posts and edits. A dry run (`craft-auto review-post --repo R`) lists the bodies without posting.

- **Live check.** Right before posting the PR is read from GitHub. Only an open PR whose head is the reviewed head gets the review; any other is skipped and returns after a new review at its new head.
- **One review per PR.** The review's node id and head are stored in `review_posts`. An Opus review at a later head edits our earlier review (`updatePullRequestReview`) instead of adding another. Each post and edit is audited (`review-post`, `review-edit`).
- **Body.** A fixed template (listed on the Prompts page as `review.post`): an italic first line, `AI-generated review (Opus 5.5). Not a maintainer decision.`, with the model name and version taken from the model id stored on the review; a verdict line in neutral words (take: no blocking problems found; take-fix: small fixes needed; hold: changes needed; close: significant problems found; a note when Opus was not sure); the `public` summary and points that Opus wrote for the PR author (plain statements about the code, with file:line, at most 8 points; no mention of other reviews, models, CI state, mergeability or the pipeline); one `Recommendation: …` line (below); and `Reviewed at <short sha>.` Opus's internal reason, fixes and risks are never posted. A review without a valid `public` field (`opus_reviews.public_review` is null) is not posted; the PR gets its review after a later Opus review at a new head. The model's text is untrusted: mentions are removed, each item is one line of at most 600 characters, and the body is cut at 6000 characters; the Recommendation line and the `Reviewed at` line are reserved first and never cut.
- **Recommendation.** The last line before `Reviewed at` says what the pipeline does next, derived at posting time from the PR's merge queue entry and the repo's merge and push approvals, and recomputed when the review is edited at a new head. Take, inside the merge rule and merging approved: `merge after CI and checks pass.`; take otherwise: `merge, after a maintainer's decision.`; take-fix: `merge after the fixes above.`, with `; they may be pushed to this branch.` when the repo has push approval and maintainers can modify the PR; hold: `update the pull request; it will be reviewed again.`; close, or anything unclear (no queue entry, declined): `wait for maintainer feedback.` The line names no rule, tier, score or account.

Hand-off, by final verdict: take goes to Verify, take-fix to Fix-up (with Opus's fix list), close to a "Close this PR?" decision (answered yes, Act closes it), hold waits for a person.

## Fix

Opens a PR for open bugfix issues in public Rust repos where the fix is clear. Needs the repo's **fix approval**.

- **Candidates.** No pending scope decision (needs-decision issues need a `take`), no open PR that mentions the issue, no earlier attempt, not held as a duplicate. Highest work rank first.
- **Triage.** Sonnet decides if the fix is clear. If not, the issue is held with the reason.
- **Live check.** Right before the PR is opened and right before the issue comment, the issue is read from GitHub. If it is closed, no PR or comment is made, the attempt is recorded as failed ("the issue is closed") and the mirror row is updated.
- **Patch.** Sonnet writes a diff to the listed files plus one regression test. Our code validates it: only listed files, at most 300 changed lines, no binary, symlink or mode changes.
- **Sandbox.** The patched head must build and pass; the test alone on the base commit must fail. Untrusted code runs only there.
- **Opus check.** After the sandbox passes and before anything is pushed, Opus reads the issue, the triage reasoning and the full patch with its test. A reject counts as a failed round and its reasons go into the next round's prompt; the check is recorded with the patch hash.
- **Rounds.** A failure gets a Haiku summary and a new round. Three failed rounds end the attempt (held).
- **PR.** Pushed to our fork, opened against the repo with "Fixes #N.", and the issue gets one comment, "A PR for this is in progress". The PR then goes through Review like any other.

Models: Sonnet, Haiku, Opus (patch check). Daily limit 10 attempts.

## Fix-up

For a take-fix review, Sonnet applies the listed small fixes to the contributor's branch, so the PR need not wait for them.

- **Needs** the repo's **push approval**, a PR that maintainers may modify, and no conflict. Otherwise the PR is held ("cannot push"), with no write.
- **Cannot push.** In a repo with **comment approval**, one comment lists the fixes (at most 6, cleaned of links and mentions), once per head, if the head is still the reviewed one. The PR shows as "asked the contributor"; a new head goes back to Review. Without the approval it stays held.
- **Safety.** The checkout is untrusted: no working tree, hooks or filters run. The diff may touch only the files named in the review, at most 300 lines.
- **Opus check.** Before the push, Opus reads the PR, the review's fix list and our patch. A reject pushes nothing, records the try as "rejected" with Opus's reason and counts as one of the 2 tries; the check is recorded with the patch hash.
- **Live check.** The PR is read from GitHub before the model calls and again after the Opus check. If it is no longer open, is a draft or its head moved, nothing is assigned or pushed and the PR is tried again on a later run.
- **Push.** One commit "Apply review fixes", pushed with a lease so a branch that moved is left alone, plus one comment from a fixed template.
- **Hand-off.** The new head is reviewed again. At most 2 tries per PR. Daily limit 20 PRs, pushes and comments together.

Models: Sonnet (patch), Opus (patch check).

## Verify

Builds and tests `take` PRs in the sandbox. Only Rust repos (a `Cargo.toml` at the root), public PRs whose CI does not fail. For a private or non-Rust repo Verify records `unavailable` ("not verified") instead, and the PR goes on to the Merge? decision.

- **Plan.** Sonnet, no tools, picks one kind: `ci-enough` (no task), `tests` (up to 5 crates, optional test filters) or `regression` (bugfixes only: a test that fails on the base commit and passes on the head). Our code validates the plan; anything invalid is an error.
- **Result.** Pass or fail comes from exit codes only, never from a model.
- **Regression.** The test must fail on the base commit and pass on the head. If it also passes on the base, the verification fails with "regression test passes on base" and the PR is held.
- **Failure.** Haiku writes a summary of at most 60 words from the failing step's log (credentials scrubbed, quoted as untrusted). The PR is held.
- **Errors.** An environment error is retried once per head. An operator can plan a failed or errored verification again from the Item page ("Verify again").
- **Stale.** A verification counts only at the head it was made for (the checks table's head when newer than the mirror's, as in Review); a push or a close cancels its tasks.

Models: Sonnet (plan), Haiku (failure summary). Daily limit 30 PRs.

## Merge queue

The queue lists every PR whose final review (Review, second pass) is take or take-fix at its current head ([Merge queue](/queue), read-only), with one state each: ready, waiting-ci, ci-failed, conflict, needs-fix-up, waiting-opus (Sonnet's take or take-fix, Opus has not reviewed the head yet), waiting-verify, verify-failed, verify-error, needs-decision, decision-answered-merge, declined, refused, merged, and for PRs in an integration batch batch-checking, in-batch and batch-failed.

**Merge without asking** only when all of these hold at the PR's current head:

- final review verdict is take (not take-fix)
- size S or M
- type is bugfix or infra (tests, CI, docs, build)
- author is on the whitelist (see Contributors)
- CI is green
- Verify passed, or planned "CI is enough"
- GitHub reports it mergeable

A take PR that fails any of the first four, is not verified (Verify `unavailable`) or has no CI checks gets a "Merge this PR?" decision (Merge, Hold, Close) once Verify has an outcome, and its question says "not verified: <reason>" or "no CI". Such a PR is never merged by the rule. The `merge-ask` step asks these decisions for every tracked repo, whether or not merging is approved there; it writes only decisions. One decision per head, so a push asks again. An answer of merge needs a mergeable PR and the head must not have moved; it also needs green CI and a passed Verify, except for a PR whose question said "no CI" or "not verified".

A PR held by an open Duplicate? decision shows as `held-duplicate` and is not merged.

**Merge step.** Needs the repo's **merge approval**. It lands the PRs that may merge in integration batches (below), assigns the batch PR to the pipeline's account (and each member PR nobody is assigned to, when its batch starts) and runs `safe-merge --merge`. `safe-merge` is built in (`craft-auto safe-merge OWNER/REPO PR --squash|--merge`); it refuses unless the PR is open, not a draft, mergeable and every check and Actions run for the head finished green, and it merges pinned to that head. `$CRAFT_AUTO_MERGE_CMD` can name another command instead. It never calls `gh pr merge` itself and never passes `--allow-pending`. A refusal is recorded with its reason and the batch stays open; any other error stops the run. A PR in a repo Verify cannot build (`unavailable`) is merged on its own through `safe-merge` (squash, or merge when the commits have more than one author). Haiku writes the failure summary of a held PR. Daily limit 10 PRs: a batch of 6 uses 6.

**Integration batches.** A batch starts whenever a repo has PRs that may merge and no batch in flight there; nothing waits for more PRs. It takes PRs in work-rank order, up to the repo's batch size (1 to 10, starting at 10), at most about 2,000 changed lines in all; an L-size PR goes alone. A PR that conflicts with the batch so far waits for the next batch.

1. Build `integration-<repo>-<yyyymmdd>-<n>` from the current default branch by merging each PR head with a merge commit in the cached bare clone (`git merge-tree`, no working tree, no hooks or filters). Contributor commits stay, so GitHub marks each PR merged when the batch lands.
2. Check the combined tree in the sandbox: a build task on the default branch head with the combined diff as its patch, running the same fetch, build and test steps Verify uses.
3. Push the branch to the pipeline account's fork and open a PR to the storytold repo that lists the batch's PRs as links. Upstream CI runs on it.
4. When upstream CI is green and the PR is mergeable, `safe-merge --merge` lands it. The repo's batch size grows by one.

If the sandbox check or upstream CI fails, the batch is split in half and each half is retried, and the repo's batch size halves (minimum 1). A single PR that fails goes on hold (`batch-failed`) with Haiku's summary, until it has a new head. A person closing the batch PR holds its PRs the same way.

Rebuilds. A PR in the batch that is no longer mergeable by the rule or the operator's answer, or that was closed, merged or pushed to on GitHub, leaves the batch: right before the batch branch is pushed and again right before the merge command one query checks every member for state OPEN at the batched head, and the rest are rebuilt in a new batch (merge, not rebase). When the default branch moves, the batch is kept if its tip still merges cleanly with the new head (GitHub's mergeable flag and upstream CI on the batch PR cover the rest); a conflict, or GitHub reporting one, closes the batch PR and rebuilds. A batch PR merged by someone else is recorded as merged.

Assignment. When a batch is created, each member PR with no assignee is assigned to the pipeline account (audit action `assign`). When a member leaves the pipeline without merging (it failed alone and is held, was dropped from a rebuilt batch and is no longer eligible, or its batch PR was closed by a person), the assignment is removed (audit action `unassign`) only if the audit shows we made it and we are still the only assignee. A member that goes into a new batch keeps it. Single merges are assigned when they merge.

Limits and exclusions. A PR whose own diff is binary or larger than the task limit is left out of batches and merged on its own, like PRs in repos with no CI (a batch PR would never turn green). A batch with more PRs than the daily limit has left waits, and rebuilds and splits take at most what is left. A build-environment error keeps the batch checking: the task is queued again at once, then after 5 minutes doubling up to 30 minutes; the batch is never split or held for it. A merge job that started, opened, advanced, split or merged a batch counts as having made progress. A crash after the batch PR was created is repaired by adopting the open PR of the branch. Fetches into the shared cache retry on ref-lock errors.

The pipeline's own integration PRs (author the pipeline account, number in `merge_batches`) are left out of classify, labels, review, Opus review, duplicates, decide, act, fix-up, verify and the queue. There is no Opus review of the combined diff. The Merge queue page lists the batches with their PRs, state and batch PR.

## Act

Makes the GitHub comments and closes that follow an operator's answer. No model. Needs the repo's **comment approval**; daily limit 20 items.

| Trigger | Action |
|---|---|
| Scope decision answered `close` | One comment, then close |
| "Close this PR?" answered `close` | One comment, then close the PR |
| Duplicate decision answered `close` | `Duplicate of #y.`, then close |

- **Close this PR?** The step asks it for each PR whose latest review says close at the current head: options Close, Hold, Keep open. A new head asks again, and an answer given at an old head is skipped.
- **Comment rules.** Comments are fixed templates in code (listed on [Prompts](/prompts)): one or two short factual lines, a fixed first sentence and at most `Reason: <text>`, cut to one line of 200 characters with `@`, URLs and Markdown links removed. The reason text may come from a model; the decision page shows the exact comment, and the operator's answer approves that text.
- **Before writing,** the step re-reads the item and skips it, without a comment, when it is already closed or merged, gone, or its head moved. A comment is never posted twice.

## Which model does what

| Model | Used for |
|---|---|
| Jev | First sort of every item (classes, duplicates). Very cheap and fast and reports how sure it is: at 90 % or more it matched maintainers' labels 98 % of the time |
| Haiku | Second opinion where Jev is unsure; batch priority and duplicate checks; duplicate decision summaries; failure summaries |
| Sonnet | Referee for label disagreements outside the scope labels (a person only when it is unsure), decision summaries, first review pass, fix-ups, issue fixes, verify plans |
| Opus | Final review of every PR Sonnet rates take or take-fix (verdict, complete fix list, how sure it is); checks of the patches Fix-up and Fix write |

These calls run with tools: Read, Grep and Glob on a read-only checkout inside a sandbox (see Trust boundary): the Opus review, the Fix-up patch and its Opus check, the Verify planner (checkouts of the PR head), and Fix triage, patch and Opus check (checkouts of the base commit). Every other call runs without tools. The Prompts page shows each prompt's tools, turn limit and sandbox mode.

[Prompts](/prompts) shows every prompt exactly as sent. The code can call a model only with a registered prompt. Classifiers and Cost show how often the models agree and what each stage costs.

## Claude accounts and agent runs

An agent run is one model call: one `claude -p` call or one Jev request. Each is recorded when it starts and ends (prompt id and version, model, account, item refs, tokens, summary). Prompts and raw output are kept 14 days; the rest 90 days. The Agents page lists runs.

Operators manage accounts on the Accounts page (under Operations); viewers see the same page without controls. Labels, config directories and logins are the only account data kept here. Config directories, credentials, tokens and email addresses never appear in the API, logs or UI.

- **Add.** An operator gives a label. The account gets an empty config directory, `<CRAFT_AUTO_ACCOUNTS_ROOT>/<id>` (mode 0700), and starts disabled. Accounts listed in the `CRAFT_AUTO_ACCOUNTS` file are added to the list on first start with their own directories.
- **Sign in.** *Sign in* runs `claude auth login --claudeai` for that account's config directory, hidden in a pseudo-terminal, and shows the sign-in URL. The operator opens it, signs in, and pastes the code the page shows into the dialog. The code is checked against a strict pattern, sent to the command and never stored or logged. A sign-in ends when the code is accepted or refused, after 30 seconds without an answer to the code, after 10 minutes, or on Cancel.
- **Status.** `claude auth status` gives signed in or out, the login method and the plan. The login's end date comes from the refresh-token expiry in the credentials file; only that number is read. Status is read every 15 minutes, after a sign-in or sign-out, and on *Refresh*.
- **Sign out** runs `claude auth logout`. **Enable** and **Disable** set whether the runner may use the account.
- **Usage.** For each enabled, signed-in account the runner runs `claude -p /usage --output-format json --verbose` every minute (every 5 minutes after a failed reading, and on *Refresh*). `/usage` is a local command: it makes no model call and spends no tokens. Its report gives the 5-hour (`session`) and weekly (`weekly_all`) use and reset times; a limit whose window has not started is left out. The reading is saved as `<id>.json` in `CRAFT_AUTO_USAGE_DIR` (default `<CRAFT_AUTO_ACCOUNTS_ROOT>/.usage`) in the format below, and a reading older than 30 minutes counts as unknown.

Before each call, the runner picks an enabled account with a free slot and headroom (5-hour and weekly use under the pause levels, which operators set; default 80 % for both; a reading older than 30 minutes counts as unknown), preferring the lowest weekly use. When none qualifies, the call waits. Stages that call Claude show as paused, with the reason, while no account has headroom. Jev calls use no account; their parallelism is the `jev_parallel` setting (default 4). The pause levels are the `usage_pause` setting (`{"fiveHour":80,"weekly":80}`), changed on the Accounts page or with `craft-auto accounts pause`.

## Build environments and tasks

Untrusted code (a PR's build and tests) never runs where the GitHub token or a Claude login is. It runs as a task on a build environment, a worker an operator registers.

- **Worker.** Holds no GitHub token, no Claude login and no database access. It fetches public source anonymously by commit and pulls tasks by key.
- **Task.** Names the source (repo, head and base commit), what it requires (OS, toolchains, memory), a plan of steps with timeouts and network setting, an optional patch (1 MiB at most, applied before the first step) and an optional warm build cache key.
- **Scheduling.** Workers claim queued tasks that match their capabilities, by priority. A task without a heartbeat for 2 minutes is requeued once, then fails. Cancelling a task stops it at once.
- **CI parity.** Before the first step the worker reads the repo's `.github/workflows/ci.yml` at the task's base commit (never the PR head, so a PR cannot choose packages or env) and, when it calls the suite's `craft-common-actions` gate, takes the gate's inputs plus the defaults in `gate.yml`: the `packages` list, `craft-fonts-ref`, `require-craft-fonts`, and the `env`, `linux-env` and `dev-debug` settings. Packages go into a derived image, `craft-sandbox/<toolchain>-<hash>` (hash of the base image reference and the sorted package list), built once with `apt-get` and network by the worker and then reused. craft-fonts at the pinned commit, and craft-i18n at the commit in the checkout's `craft-i18n.rev`, are downloaded by commit into the worker's work dir and mounted read-only at `/craft-fonts` and `/craft-i18n`, with `CRAFT_FONTS_DIR`, `CRAFT_FONTS_REQUIRED` and `CRAFT_I18N_DIR`/`CRAFT_I18N_REQUIRED` set for every step. Steps still run offline except `fetch deps`. The task detail lists the image, package count and both commits. A repo whose CI does not call the gate runs in the stock image. Only Linux inputs apply; the gate's Rust toolchain, targets and cargo tools are not reproduced.
- **Results are data.** Logs and artifacts are size-capped, typed by content (PNG, JSON, JUnit XML, text) and served with `nosniff` and a sandboxing policy. Nothing a worker sends is executed, rendered as HTML or put in a prompt by the coordinator. A later step that lets a model read it frames it as untrusted.
- **Access.** Worker calls arrive on their own listener, authenticated by key (stored hashed, shown once), with body caps and rate limits. Only operators register environments, rotate keys or cancel tasks, and each is audited. Tasks of repos a viewer cannot see are hidden from that viewer.
- Tasks, logs and artifacts are deleted 30 days after the task ends.

## What needs a person

- **Scope calls**: is this in scope, closer to the reference app, a plug-in rather than core?
- **Reference behaviour** that public sources don't settle.
- **Merges outside the rule** (see Merge queue). Contributors shows who is on the whitelist and why. The pipeline's own account counts as whitelisted for the Fix PRs it opened from issues (S or M bugfix after Verify can merge by the rule); an operator's deny still wins.
- **Closing a PR** the review says to close.
- **A label** where Jev and Haiku disagree outside the scope labels, and the Sonnet referee is unsure: the Work queue says "Models disagree: needs a label" and links to the Items list of disagreements, which shows the referee's label and reason. Until the referee answers, the Work queue says "Referee: waiting for Sonnet".
- **Duplicate?** answers: an open one holds the item out of Review, Verify, Fix and the merge queue (Work queue: "Held").

Everything else waits for a decision on this dashboard.

**Releases.** An operator can release an item that stopped waiting for a person, from the Item page (two clicks, audited, nothing written to GitHub; the pipeline takes the item up on its next pass): *Review again at this head* (removes a hold review of the current head), *Verify again* (after failed or error) and *Try the fix again* (a skipped or failed issue fix; the attempt count starts over).

**Applied answers.** An answer that writes nothing counts as applied once the pipeline used it (scope take / small-extra when the item is reviewed or fixed, plugin when the label is on the item, need-info and Close? hold / keep at the next pass). From then the dashboard offers no Undo.

## Trust boundary

- Untrusted code never runs where GitHub or Claude credentials are (see Build environments).
- Only the operator's answers are acted on. The pipeline reads the chosen option, never free text.
- Comments and picks by other people are shown here but never reach a model's prompt.
- All GitHub text is untrusted data: models judge it and never follow instructions in it.
- Every GitHub write (labels, comments, closes, pushes, fix PRs, merges) needs the operator's approval for that repo, given on the Repos page; the CLI reads approvals and cannot set them. Approvals are audited.
- Model calls run without tools, except a prompt that registers a sandbox mode (the Opus review, Fix-up patch and check, Verify planner, Fix triage, patch and check). Claude Code's file tools could otherwise read anything this user can, such as tokens and other accounts' logins, and untrusted text could steer a model into echoing it. Two layers keep that from happening, plus a backstop:
  1. Claude Code allows only `Read`, `Grep` and `Glob`, denies everything else without asking (`dontAsk`, no prompts), allows reads of the checkout path only, is confined to the working directory and the checkout (`--restricted`), loads no MCP servers, skills, slash commands or user and project settings, and stops after a registered number of turns.
  2. bubblewrap runs the call in new namespaces (network shared, the API needs it) with an empty home and a clean environment. Only these are visible: the claude binary, `/usr`, the TLS certificates and resolver config, the checkout read-only at `/repo`, and the used account's credentials file, read-only (the rest of its config directory is not). The working directory is an empty `/work` and the checkout is added with `--add-dir`, so instructions and settings inside the checkout are never loaded as project memory; `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md` and every `.claude/` path are also left out of the checkout.
  3. Backstop: after the reply JSON is parsed, anything in its text (and in stderr) that looks like a token or key is removed before it is stored or used (the log scrubber).
  The sandbox never refreshes the OAuth token, since a refresh inside it could invalidate the account's stored login. Before a sandboxed call the code reads only the token's expiry; with under 30 minutes left, the call runs without tools on the host (logged as `sandbox skipped: token near expiry`), where refreshing is safe.
  The checkout is built from the cached clone without a working tree: only regular files under validated paths are written (no symlinks, submodules or `.git`), files over 2 MB are left out, and a tree over 20,000 files or 150 MB gets no checkout. Nothing in it is executed. Checkouts are kept per repo and commit and deleted after a day. When there is no checkout, the head moved, or bubblewrap is missing, the call runs without tools (`CRAFT_AUTO_NO_SANDBOX=1` forces that).
- Only operators can turn the pipeline on or off, change limits, manage accounts or cancel jobs. A maintainer or viewer account, even a compromised one, cannot trigger a merge, close, post, label, push or any step.

## Architecture

Three processes share one database. None needs a terminal or Claude session kept open.

| Process | What it does |
|---|---|
| Sync | Copies changes from GitHub into the mirror, every minute |
| Dashboard | Shows everything to people on the access list; records answers, opinions, the pipeline switch and limits. Never runs a step or calls a model |
| Runner | Runs the pipeline steps as jobs, each in its own process, and records progress, logs, results and token use |

Each step has a fixed list of settings (a choice, a tracked repo, a bounded number or a run id). Nothing typed on the dashboard can reach a prompt or a shell. Steps in the same concurrency group run one at a time.

### Live updates

Pages update without a reload. The database is the single source of truth and the browser only caches views of it. Triggers on the tables the dashboard reads bump a per-topic counter in `change_seq` (topics: items, ranks, stages, checks, classify, dupes, decisions, jobs, queue and others, listed in `src/live.ts`), whichever process wrote the row. An UPDATE bumps only when a column other than the bookkeeping ones (fetch and compute times, derived hashes) changed, and the settings the runner and sync keep for themselves bump nothing. The dashboard reads the counters twice a second and sends the changed topic names over a server-sent event stream (`GET /api/live`, one per browser tab, with a heartbeat every 25 s). The browser refetches the cached views that read those topics (`web/src/api/topics.ts`), each view at most once every 3 s. A reconnecting tab gets the full counter map first and refetches what changed while it was away. Actions are ordinary POSTs; their effects come back through the same stream. Views that change without a database write, such as a job's log tail and the runner's heartbeat age, poll slowly.

### On and Off

The pipeline starts **Off**. An operator switches it on the Pipeline page or with `craft-auto pipeline on|off`; the switch records who and when. Off cancels waiting automatic jobs and queues no new ones; running jobs finish.

While On, the runner plans whenever the content the stages read changed (a change-counter topic other than jobs, usage, agent runs, sandbox environments and audit moved, or a sandbox task ended), a job ended, an operator changed a limit or released work, or a wait the last pass found ended. A 5-minute timer is only a fallback. The planner queues a job for each stage that has work, no job queued or running, and limit left. Per-repo stages (Label, Review, Merge, Act, Fix-up, Fix) queue only for repos with the matching approval.

A stage does not wait on a timer when it has work. Two rules decide when a stage that has work is held back:

- **Same input.** Each queued job stores a fingerprint of the input it saw (the stage, the repo and the counters of the topics the stage reads). A job that handled no items and made no other progress (no batch started, opened or advanced, no decision asked) is not queued again until the fingerprint changes. A step reports such progress with `acted`, next to `items`.
- **Failures.** After a failed job the stage waits 1 minute, then 2, 4, 8 and 16, then 30 minutes, until a job succeeds. A changed fingerprint or an operator release ends the wait at once. Jobs a runner stop ended do not count.

Stages that watch an outside system (upstream CI of PRs waiting for it, open batch PRs, finished sandbox tasks) are exempt from the first rule and read it again every minute. The full classification pass is never started automatically.

**Pilot.** The setting `pilot_items` (a list of `repo#number` items and whole `repo`s) limits every stage to those items and repos. Classify, Priority, Dupes (the listed items as subjects; their neighbours may be any item), Referee, Decide, Review, Opus review, Post reviews, Label, Verify, Fix-up, Fix, Merge and Act pick candidates among them only; Embed and Rank stay unrestricted because they are local and cheap. A Fix PR the pipeline opened for a pilot issue counts as a pilot item. Integration batches in flight finish. Empty or absent means no pilot. Operators set it on the Pipeline page or with `craft-auto pipeline pilot set <repo#number|repo>...`, `pilot show` and `pilot clear`; each change is in the audit log.

### Daily limits

Limits count items handled per stage per day (from 00:00 UTC), including by failed or stopped jobs. Operators change them on the Pipeline page or with `craft-auto pipeline limit`. Empty means no limit; 0 pauses the stage. The page shows why a stage cannot start.

| Stage | Limit | Stage | Limit |
|---|---|---|---|
| Classify | 2000 | Verify | 30 |
| Priority | 3000 | Merge | 10 |
| Duplicates | 2000 | Act | 20 |
| Decide | 100 | Fix-up | 20 |
| Review | 40 | Fix | 10 |
| Referee | 500 | Compare duplicate groups | 200 |
| Opus review | 40 | Post reviews | 40 |

Embed, checks and Label have no limit.

### Waits

Automated work waits only for the reasons below. A stage that is not running shows its reason on the Pipeline page: nothing to do, waiting for CI on N PRs, failed with the retry time, the daily limit, or a pause.

| Wait | Why | How long | Shows as |
|---|---|---|---|
| Failed job | Retry a real failure without hammering | 1, 2, 4, 8, 16, then 30 minutes; ends on a release, and after a single failure also on a changed input | "failed N times in a row; retry at HH:MM UTC" |
| Upstream CI of PRs and open batch PRs | External | Read again every minute per repo while any waits | "waiting for CI on N PRs in repo" |
| Sandbox build | External | Until the task ends; build-environment errors queue it again after 0, 5, 10, 20, 30 minutes | Batch state `checking` |
| Checks before Review and Verify | CI data younger than 5 minutes is reused | 5 minutes | Job list |
| Daily limit | Cost control | Until 00:00 UTC | "daily limit of N items reached; resumes at 00:00 UTC" |
| Claude usage pause | Account headroom | Until usage reading recovers; re-read every minute | Claude pause reason |
| Rate limits | GitHub | Per the API's reset | Job log |
| Duplicate set changed on GitHub | Wait for the sync to bring the set | 10 minutes | Duplicates stage |
| Rule fallback of a duplicate group | The model call failed; retried up to 3 times | 15 minutes | Duplicates stage |
| Planner fallback | Safety net; the planner normally runs on a change | 5 minutes | none |
| Work rank recompute | Its input moves in bursts while a sync writes; nothing waits on it | at most once a minute | none |
| Sync | Poll of GitHub | 1 minute; the search catch-up runs hourly, the reconcile daily | Syncs list |
| Warm build of the default branch | Limits sandbox load; never blocks a PR | Once a day per repo | Sandbox tasks |
| Flow summary and vector index | Display and search caches | 10 and 30 minutes at most; also rebuilt on change | none |
| Retention | Pruning old rows and logs | Days to months | none |

| Who | On the Pipeline page |
|---|---|
| Anyone signed in | Sees the switch, limits and use today, every stage and job with its log, result and cost, and recent syncs |
| Operator | Also turns the pipeline on and off, changes limits and cancels jobs; all audited |

Logs hold no secrets; anything that looks like a token is hidden.

## Commands

Dry run is the default for every writing command; `--apply` writes (and still refuses unapproved repos).

| Command | Stage |
|---|---|
| `craft-auto sync`, `embed`, `dupes`, `classify`, `prioritize` | Sync to Priority |
| `craft-auto rank`, `rank show <repo> <n>` | Work rank |
| `craft-auto decide [--repo R]` | Decide |
| `craft-auto labels ensure\|plan\|apply --repo R` | Label |
| `craft-auto checks --repo R`, `review --repo R`, `opus-review --repo R`, `review-post --repo R [--apply]` | Review |
| `craft-auto fixissue --repo R`, `fixissue-collect` | Fix |
| `craft-auto fixup --repo R` | Fix-up |
| `craft-auto verify --repo R`, `verify-collect` | Verify |
| `craft-auto queue`, `merge --repo R` | Merge queue |
| `craft-auto act --repo R` | Act |
| `craft-auto pipeline on\|off\|limit`, `accounts list\|set\|jev` | Switch, limits, accounts |
