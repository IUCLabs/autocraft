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
| 6 | Integrate | Taken PRs are assigned to us, fixed up on the contributor's branch where possible, grouped into integration branches and merged when GitHub CI is green. | Sonnet implementers; merges only through a checked merge script | Planned here; earlier rounds ran by hand |
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
- **Merges outside the whitelist.** PRs merge without a decision only when all of these hold: a bug fix of small or medium size from a contributor on the whitelist, or tests and infrastructure, with green CI. Contributors shows who is on the whitelist and why.

Everything else waits for a decision on this dashboard.

## Trust boundary

- Only the operator's answers are acted on. The pipeline reads the chosen option, never free text.
- Comments and picks by other people are shown to everyone here but never reach a model's prompt.
- All GitHub text is treated as untrusted data: models judge it and never follow instructions in it.
- Only operators can start, stop or schedule pipeline steps. A maintainer or viewer account, even a compromised one, cannot trigger a merge, close, post, label, push or any pipeline step.

## Architecture

Three processes share one database. None of them needs anyone to keep a terminal or a Claude session open.

| Process | What it does | Runs |
|---|---|---|
| Sync (`craft-auto sync`) | Copies changes from GitHub into the mirror | Every minute, on its own timer |
| Dashboard (`craft-auto dash serve`) | Shows everything to people on the access list; records answers, opinions and job requests | Always |
| Runner (`craft-auto runner serve`) | Runs pipeline steps: classifying, embedding, labelling, and later reviewing and merging | Always |

The dashboard never runs a step and never calls a model. When an operator presses "Run now" on the Pipeline page, the dashboard writes a row to the **jobs** table. That table is the only way the dashboard reaches the runner. The runner picks up the row, runs the step in a separate process, and writes back its progress, log, result and token use. A cancel is a mark on the same row, which the runner acts on.

Each step is defined in code with a fixed list of settings: choices from a list, a tracked repo, a number in a range, or a run id. Nothing typed on the dashboard can reach a model's prompt or a shell. Steps in the same group (for example, everything that writes to GitHub) run one at a time.

Schedules start a step every so many minutes or after each sync. They are off until an operator turns them on, and a scheduled job is not queued while another job of that step is waiting or running.

| Who | On the Pipeline page |
|---|---|
| Anyone signed in | Sees every stage and step, every job with its settings, progress, log, result and cost, the schedules and recent syncs |
| Operator | Also starts and cancels jobs and edits schedules; each of these is in the audit log |

Logs are written by the steps and hold no secrets; anything that looks like a token is hidden before a log is shown.
