# How the triage pipeline works

The craft apps have about 21,000 open issues and PRs. The pipeline sorts all of them, reviews and merges the PRs we want, and fixes clear bugs. People make the calls that need judgement: they answer decisions on this dashboard. Models do the reading, sorting and reviewing.

## Stages

| # | Stage | What happens | Who or what does it | Status |
|---|---|---|---|---|
| 1 | Mirror | Every issue, PR and comment of the tracked repos is copied into a local database. Later stages read the mirror, never GitHub directly. | `craft-auto sync`, every minute: one org-wide GitHub search for changes | Automatic |
| 2 | Classify | Every open item gets one type label (bugfix, performance, missing feature, small extra, plugin candidate, infra) and two flags (security, needs decision). | Jev first. Where Jev is under 90 % sure, Haiku as well. Where they disagree, the item goes to a person or to Sonnet | Scripted, started by the operator (`craft-auto classify`) |
| 3 | Decide | Items flagged "needs decision" (scope, wanted or not, reference-app behaviour), and items where Jev and Haiku disagree between scope labels, become decisions on this dashboard, each with an AI summary and the item's own text. | `craft-auto decide` asks them, with summaries by Sonnet. The operator answers; anyone signed in can comment and pick an option | Scripted, started by the operator |
| 4 | Label | The type label and flags go onto the item on GitHub. | `craft-auto labels`, one repo at a time. No model calls. Only items whose type is settled (Jev at 90 % or more, or Haiku agreeing with Jev) are labelled. A label a person set is never changed: an item that already has a different type label is skipped and reported. Writes to GitHub need the operator's approval for that repo, given on the Repos page | Built. `ensure` and `plan` are read-only; `apply` is a dry run unless `--apply` and refuses unapproved repos |
| 5 | Review | PRs we want get a code review: take, take with fixes, hold, or close (duplicate, already fixed, superseded). | Sonnet, one call per batch of related PRs. Tests are not reviewed, only code | Built, one repo at a time (`craft-auto review`) |
| 6 | Integrate | Taken PRs are assigned to us, fixed up on the contributor's branch where possible, grouped into integration branches and merged when GitHub CI is green. | Sonnet implementers; merges only through a checked merge script | Merge queue and merge step built (`craft-auto merge`); fix-ups and integration branches next |
| 7 | Fix issues | Issues with a clear bug and a clear fix get a PR from us. | Sonnet implementers | Planned |

Stages 5–7 go one or a few repos at a time, in turn. Stages 1–4 cover the whole org.

## Stage 5: Review

`craft-auto review --repo R [--limit N] [--dry-run]` reviews one repo. The pipeline's runner calls the same code as `runReview(db, {repo, limit, dryRun}, log)`.

**Which PRs.** Open, non-draft PRs whose settled type label is bugfix, performance, missing feature, small extra or infra. A PR flagged "needs decision" waits until its scope decision is answered `take` or `small-extra`; any other scope answer keeps it out. A PR already reviewed at its current head commit is skipped, so a run can stop and restart at any point, and a push to a reviewed PR brings it back. `--limit` takes the smallest PRs first.

**What the reviewer sees.** For each PR: title, body, size (S up to 50 changed lines, M up to 300, L above), CI state, mergeability, the files it changes, and the diff of its code. Test files and lockfiles are listed but left out of the diff; a PR that changes only tests shows its tests. Other PRs in the run that change the same files are named, so the reviewer can mark overlaps and duplicates.

**Data.** CI and merge state come from one GitHub query per 40 PRs and go into `pr_checks` (head commit, state per check, overall success, failure, pending or none, mergeable, maintainer can modify). `craft-auto checks --repo R` refreshes it for every open PR of a repo. Diffs come from `gh pr diff` and are cached by head commit under `$CRAFT_AUTO_DIFF_CACHE` (default `~/.cache/craft-automation/diffs`). The stage reads GitHub and never writes to it: comments, labels and assignments belong to stage 6.

**Batches.** PRs that share a file go into the same call where they fit, then PRs of the same area. A call holds at most 15 PRs and 120,000 characters of diff. A PR with more than 1,500 changed code lines, or one GitHub won't return a diff for, is held as too large to review automatically without a model call.

**Prompt.** `review.sonnet` on [Prompts](/prompts), sent to Sonnet with no tools. Diffs and PR text are quoted as untrusted data.

**Verdicts.**

| Verdict | Meaning |
|---|---|
| take | Wanted, correct, nothing to change |
| take-fix | Wanted and nearly right; small mechanical fixes are listed per file |
| hold | Needs a person: unsure reference behaviour, a design or scope choice, overlaps that need a choice, a duplicate whose better PR has not merged, or too large to review automatically |
| close | Wrong or broken beyond a small fix, not wanted, already done on the main branch, or superseded |

The weaker of two duplicates is held, never closed, until the better one has merged; a close that names an unmerged duplicate is stored as a hold.

**Storage.** One `reviews` row per PR and head commit: verdict, reason (25 words at most), fixes, duplicate_of, overlaps, risks, model, size, run. Each review also adds two `stages` rows: `reviewed` (verdict, short head commit and reason) and the verdict itself (`take` for take and take-fix, `hold`, `close`), which the Progress page counts. Token use goes to `token_usage` with stage `review`.

## Stage 6: Integrate

Built so far: the merge queue and the merge step. Fix-ups of take-fix PRs and integration branches come next.

**Merge queue.** Every PR whose latest review is take or take-fix at its current head commit, plus the ones merged since. [Merge queue](/queue) shows it, read-only, with one state per PR:

| State | Meaning |
|---|---|
| ready | The merge rule covers it, CI is green and it is mergeable: the next run merges it |
| decision-answered-merge | Outside the rule, but the operator answered the Merge? decision `merge` at this head commit |
| refused | The merge command or a pre-merge check said no; the reason is shown, and the next run tries again |
| waiting-ci | CI is pending or has not run at this head, or GitHub has not worked out mergeability yet |
| ci-failed | CI fails at this head |
| conflict | Conflicts with the base branch |
| needs-fix-up | The review is take-fix: it waits for the fix-up step |
| needs-decision | Outside the rule: it waits for the operator's answer to a Merge? decision (asked on the next run when not asked yet) |
| declined | The operator answered the Merge? decision `hold` or `close` |
| merged | Merged |

`craft-auto queue [--repo R]` prints the same list.

**Merge without asking.** A PR merges without a decision only when all of these hold:

- the review verdict is take (not take-fix) at the PR's current head commit;
- its size is S or M (up to 300 changed lines);
- its settled type label is bugfix or infra (infra covers tests, CI, docs and build);
- its author is on the whitelist (tier whitelisted, or an operator's allow override; see Contributors);
- CI is `success` overall at that head commit;
- GitHub reports it mergeable.

**Merge? decisions.** A take PR that fails any of the first four gets a decision instead: "Merge this PR?" with options `merge`, `hold` and `close`, and facts for size and label, author and tier, CI and mergeability, the review's verdict, reason and fixes, and the head commit. There is one decision per PR head commit, so a push brings a new one. It is asked only while CI is not failing and the PR has no conflict. Only an operator's answer counts, read as an option key (`craft-auto decisions list --actionable`). An answer of `merge` makes the PR eligible at that head: CI must still be green and the PR mergeable, and the step refuses when the head commit moved since the question was asked.

**Merge step.** `craft-auto merge --repo R [--limit N] [--apply]`; the runner calls `runMerge(db, {repo, limit, dryRun}, log)`. Without `--apply` (or with `dryRun` unset) it is a dry run: it prints what it would merge and ask, from the local tables, and calls and writes nothing. With `--apply` it:

1. writes a `batched` stage row for each queued PR, once per head commit, and asks the missing Merge? decisions;
2. takes the eligible PRs one at a time, rule PRs first, up to `--limit` merges;
3. refreshes that PR's checks and head commit, and refuses when it is no longer open, its head moved, the operator's answer is gone, or CI or mergeability changed;
4. assigns the PR to the pipeline's GitHub account (the signed-in `gh` account, read once per run) when nobody is assigned;
5. runs the merge command (`$CRAFT_AUTO_MERGE_CMD`, default `safe-merge`) as `<cmd> storytold/<repo> <n> --squash`, or `--merge` when the commits have more than one author. It never calls `gh pr merge` itself and never passes `--allow-pending`.

A refusal by the command is recorded with its reason and the PR stays in the queue. Any other error stops the run. Each try adds a `merges` row (head commit, rule or operator, squash or merge, merged or refused, reason) and an audit row (`assign`, `merge`, `merge-refused`); a merge adds a `merged` stage row and marks the operator's decision applied. The step makes no model calls.

### Label stage commands

- `craft-auto labels ensure --repo R [--apply]` creates the missing labels of the set (bugfix, performance, missing feature, small extra, plugin candidate, infra, security, needs decision) with colour and description. Without `--apply` it prints what it would create.
- `craft-auto labels plan --repo R [--run RUN] [--csv FILE|-]` prints counts (to add, already labelled, unsettled, conflicts) and writes a CSV of the labels per open item.
- `craft-auto labels apply --repo R --run RUN [--limit N] [--apply]` adds the planned labels in batches of 10 mutations, at most 60 writes a minute, waiting out rate limits. It writes a `labeled` stage row per item and one audit row per batch, and a re-run skips items already labelled. Without `--apply` it is a dry run. With `--apply` it refuses unless an operator approved the repo.

Approval: the Repos page has a Label approval column with a confirm button, operators only, audited (`labels-approve`, `labels-revoke`). The CLI reads the approval and cannot set it. The column also shows the plan counts: to add, skipped, conflicts.

## Which model does what

| Model | Used for | Why |
|---|---|---|
| Jev | First sort of every item | Very cheap and fast, and it reports how sure it is. On items where it is at least 90 % sure, it matched labels set by a maintainer 98 % of the time |
| Haiku | Second opinion on items Jev is unsure of; other bulk reading | Cheap; about as accurate as Jev overall |
| Sonnet | Code review, fix-ups, implementation, settling disagreements | Good enough for review at a fraction of Opus's cost |
| Opus | Planning and direction only | Expensive; used where judgement matters most |

Classifiers and Cost show how often the models agree and what each stage costs.

Every prompt sent to a model is defined in one registry (`src/prompts`), and the code can call a model only with a registered prompt. [Prompts](/prompts) shows each one exactly as sent, with its model, call settings and a rendered example.

## Claude accounts and agent runs

An **agent run** is one model call made through the prompt registry: one `claude -p` call, or one Jev request. Every run is recorded when it starts and again when it ends.

### Accounts and allocation

An operator enables Claude accounts on the Accounts page and gives each a label and a number of calls at once (default 2). Only the label is shown; the account's login and config directory never appear in the API, logs or UI. The accounts a machine has come from its box config (see the README); the page lists only those.

Before each Claude call the runner side picks an account:

1. It must be enabled and have a free slot (runs in state `running` fewer than its limit).
2. It must have headroom by its latest usage reading: 5-hour use under 90 % and weekly use under 95 %. A reading older than 30 minutes counts as unknown and is allowed.
3. Of those, the account with the lowest weekly use gets the call.

The call runs with that account's `CLAUDE_CONFIG_DIR` for its own child process only. When no account qualifies, the call waits (polling every few seconds) and stops if the job is cancelled. If no account is enabled at all, the call fails with a message that says so. Jev calls use no account.

Stages that call Claude (Classify, for its Haiku part, Decide and Review) show as paused, with the reason, and the autopilot queues no job for them while no enabled account has headroom ("paused: no Claude account is enabled", "paused: no Claude account has headroom (...)"). A job started by hand waits for an account instead.

The runner records each account's usage reading whenever it changes (`account_usage_samples`, kept 30 days). If `CRAFT_AUTO_USAGE_REFRESH` is set, it also runs that command every 5 minutes to refresh the readings.

### What a run records

Each run has its job, step and stage, prompt id and version (a hash of the prompt text), provider, model, account, up to 50 item refs and the item count, state (`running`, `done`, `failed`), times, token counts, and a one-line summary (verdict counts or the error class). The rendered prompt and the raw output are kept in a separate table for 14 days; the rest of the run is kept for 90 days. The Agents page lists runs (newest first, or only the running ones, filtered by state, step, account or repo), and the Rates page shows items moved and runs per stage by hour (24 hours) or day (7 days) next to account usage. Each job on the Pipeline page lists the models its step uses and the accounts its runs used. Runs left `running` by a process that is gone are marked failed when the runner starts or the job ends, so they do not hold a slot.

## Scope decisions

`craft-auto decide [--repo R ...] [--limit N] [--dry-run]` asks one scope decision per item. An item gets one when it is open, not a draft, in a tracked repo, and either

- its settled classification carries the "needs decision" flag (settled: Jev at least 90 % sure, or Haiku agreeing with Jev), or
- Jev and Haiku chose different labels among missing feature, small extra and plugin candidate.

Items that already have an open decision, a scope decision (answered ones too) or a later stage are skipped, so the command can run again at any time and asks only what is new. Items Haiku has not judged yet wait for it.

Each decision has a one-line question chosen by the label, up to four options, a recommendation from the classifiers' labels (none when they disagree, except plugin candidate over small extra), up to five facts (size and age, author and whitelist tier, both classifiers' labels, GitHub labels, linked items) and a 2–4 sentence summary from the `decide.summary` prompt.

The step that acts on answers reads these keys:

| Key | Meaning |
|---|---|
| `take` | In scope for core. Keep open; PRs go to review |
| `small-extra` | Keep in core as a small extra (label "small extra") |
| `plugin` | Not for core. Keep open and label "plugin candidate" |
| `close` | Out of scope. Close with a short reason |
| `need-info` | Ask how the reference app behaves, then decide again |

## What needs a person

- **Scope**: is this in scope, does it get us closer to the reference application, is it a plug-in rather than core?
- **Reference behaviour** that public sources don't settle.
- **Merges outside the rule.** A PR merges without a decision only when its review is take at its current head, it is size S or M, its label is bugfix or infra (tests, CI, docs, build), its author is on the whitelist, CI is green and it is mergeable (stage 6). Contributors shows who is on the whitelist and why.

Everything else waits for a decision on this dashboard.

## Trust boundary

- Only the operator's answers are acted on. The pipeline reads the chosen option, never free text.
- Comments and picks by other people are shown to everyone here but never reach a model's prompt.
- All GitHub text is treated as untrusted data: models judge it and never follow instructions in it.
- Only operators can turn the pipeline on or off, change the daily limits, enable or relabel Claude accounts, or cancel jobs. A maintainer or viewer account, even a compromised one, cannot trigger a merge, close, post, label, push or any pipeline step.

## Architecture

Three processes share one database. None of them needs anyone to keep a terminal or a Claude session open.

| Process | What it does | Runs |
|---|---|---|
| Sync (`craft-auto sync`) | Copies changes from GitHub into the mirror | Every minute, on its own timer |
| Dashboard (`craft-auto dash serve`) | Shows everything to people on the access list; records answers, opinions, the pipeline switch and limits | Always |
| Runner (`craft-auto runner serve`) | Runs pipeline steps: classifying, embedding, labelling, reviewing and merging | Always |

The dashboard never runs a step and never calls a model. The runner queues and runs jobs; the dashboard only reads the **jobs** table and writes the pipeline switch, the daily limits and cancel marks. The runner runs each job in a separate process and writes back its progress, log, result, items handled and token use. A cancel is a mark on the job's row, which the runner acts on.

Each step is defined in code with a fixed list of settings: choices from a list, a tracked repo, a number in a range, or a run id. Nothing typed on the dashboard can reach a model's prompt or a shell. Steps in the same group (for example, everything that writes to GitHub) run one at a time.

### On and Off

The pipeline is either **On** (running and watching all issues and doing the automations) or **Off** (stopped). It starts Off. An operator switches it on the Pipeline page or with `craft-auto pipeline on|off`; the switch records who changed it and when. Turning it Off queues no new jobs; jobs already running finish, and operators can still cancel them.

While it is On, the runner looks for work after each new sync and at least every 15 minutes, and again whenever one of its own jobs ends. It queues a job (requested by `pipeline`) for each stage that has work, has no job queued or running, and has limit left, in this order:

| Stage | Step | Work it looks for (the stage's own candidate code) |
|---|---|---|
| Classify | `classify-new` | Open items without a verdict in the current run, or whose text changed since |
| Embed | `embed` | New or changed items without a current embedding |
| Decide | `decide` | Candidates left to ask, pull requests before issues |
| Review | `checks`, then `review-batch` | Per repo, round robin across repos with review candidates, one repo per job; a repo's checks are refreshed (within the last 30 minutes) before its review |
| Label | `labels-apply` | Repos with operator approval and labels still to add, once per sync |
| Merge | `merge` | Repos with queue entries the merge rule allows |

The full classification pass (`classify-all`) is never started automatically. A failure in one stage does not stop the others. A stage whose last three automatic jobs failed waits an hour, and a stage whose last automatic job handled nothing waits 15 minutes.

### Daily limits

Each stage has a limit of items per day, counted from 00:00 UTC over the items its jobs handled (classified, asked, reviewed, labelled, merged). The job's `limit` is the smaller of the step's default and what remains of the day. An empty limit means no limit and 0 pauses the stage. Defaults: classify-new 2000, decide 100, review-batch 40, merge 10; embed, checks and labels-apply have none (labelling is gated by the per-repo approval). Operators change limits on the Pipeline page or with `craft-auto pipeline limit <step> --per-day N|none`. A stage that cannot start jobs shows why on the page (limit reached, limit 0, waiting after failures).

| Who | On the Pipeline page |
|---|---|
| Anyone signed in | Sees the switch, the limits and their use today, every stage, every job with its settings, progress, log, result and cost, and recent syncs |
| Operator | Also turns the pipeline on and off, changes limits and cancels jobs; each of these is in the audit log |

Logs are written by the steps and hold no secrets; anything that looks like a token is hidden before a log is shown.
