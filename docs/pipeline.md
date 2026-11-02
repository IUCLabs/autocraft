# How the triage pipeline works

The craft apps have about 21,000 open issues and PRs. The pipeline sorts all of them, reviews and merges the PRs we want, and fixes clear bugs. People make the calls that need judgement: they answer decisions on this dashboard. Models do the reading, sorting and reviewing.

## Stages

| # | Stage | What happens | Who or what does it | Status |
|---|---|---|---|---|
| 1 | Mirror | Every issue, PR and comment of the tracked repos is copied into a local database. Later stages read the mirror, never GitHub directly. | `craft-auto sync`, every minute: one org-wide GitHub search for changes | Automatic |
| 2 | Classify | Every open item gets one type label (bugfix, performance, missing feature, small extra, plugin candidate, infra) and two flags (security, needs decision). | Jev first. Where Jev is under 90 % sure, Haiku as well. Where they disagree, the item goes to a person or to Sonnet | Steps on the Pipeline page (`classify-new`, `classify-all`), started by the operator or a schedule |
| 3 | Decide | Items flagged "needs decision" (scope, wanted or not, reference-app behaviour) become decisions on this dashboard, each with an AI summary and the item's own text. | The operator answers; anyone signed in can comment and pick an option | Dashboard built; asking decisions from stage 2 is next |
| 4 | Label | The type label and flags go onto the item on GitHub. | Script, one repo at a time, after the operator agrees the timing for that repo | Planned |
| 5 | Review | PRs we want get a code review: take, take with fixes, hold, or close (duplicate, already fixed, superseded). | Sonnet, one reviewer per batch of related PRs; one per feature for large PRs. Tests are not reviewed, only code | Planned here; earlier rounds ran by hand |
| 6 | Integrate | Taken PRs are assigned to us, fixed up on the contributor's branch where possible, grouped into integration branches and merged when GitHub CI is green. | Sonnet implementers; merges only through a checked merge script | Planned here; earlier rounds ran by hand |
| 7 | Fix issues | Issues with a clear bug and a clear fix get a PR from us. | Sonnet implementers | Planned |

Stages 5–7 go one or a few repos at a time, in turn. Stages 1–4 cover the whole org.

## Which model does what

| Model | Used for | Why |
|---|---|---|
| Jev | First sort of every item | Very cheap and fast, and it reports how sure it is. On items where it is at least 90 % sure, it matched labels set by a maintainer 98 % of the time |
| Haiku | Second opinion on items Jev is unsure of; other bulk reading | Cheap; about as accurate as Jev overall |
| Sonnet | Code review, fix-ups, implementation, settling disagreements | Good enough for review at a fraction of Opus's cost |
| Opus | Planning and direction only | Expensive; used where judgement matters most |

Classifiers and Cost show how often the models agree and what each stage costs.

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
