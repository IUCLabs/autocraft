# Triage dashboard: specification

## Purpose

The craft-app repos have about 25,000 open issues and PRs across about 20 active repos, and more arrive every day (about 900 PRs a day across the org). An automated pipeline classifies every item, reviews the promising PRs, fixes and merges what it can, and leaves the judgement calls to the maintainers.

**The bottleneck is human judgement, not tokens or build time.** The dashboard exists mainly so that maintainers can see the open decisions and make them quickly, with enough context to decide and no walls of text. Its second job is to show progress and cost, so the maintainers can trust the process and the owner can tune it.

## Readers

| Reader | Device | Wants |
|---|---|---|
| Owner | Phone first, sometimes desktop | Make decisions in bursts; see whether the run is on track; adjust the whitelist |
| Maintainers | Desktop and phone | Decisions in their repos; what got merged or closed and why |
| Public (later) | Any | Read-only progress; no decisions UI, no private notes |

## Principles

1. **Decisions come first.** The home page is the decision queue. Everything else is one tap away.
2. **One decision fits on one phone screen**, collapsed: the question in one sentence, the options as buttons, the recommendation marked, and three to five facts. Everything else (classifier reasons, diff stats, related items, comments) sits behind an expander or on the item page.
3. **Similar decisions are answered together.** Decisions of the same kind (for example "beyond the reference app: label small extra or plugin candidate?") group into a batch the reader can answer with one choice and a list of exceptions.
4. **Counts before lists.** Every list page opens with a one-line summary ("38 decisions: 21 scope, 9 duplicates, 8 other; oldest 3 days").
5. **No page loads everything.** Lists page server-side (50 rows), filter by repo, area, type label, size, contributor tier and age, and keep filters in the URL so a link reproduces the view.
6. **Plain words.** Labels say what things are ("waiting for you", "merged by the pipeline"), not internal stage names.
7. **Never name the reference applications or their vendors.** Say "the reference app".

## Data

Read from the SQLite mirror (`src/schema.sql`, opened with `src/db.ts`). Mirror tables (`repos`, `items`, `comments`) are filled by `craft-auto sync`; work tables are written by the pipeline and by the dashboard. Schema changes go in `src/schema.sql` as `CREATE ... IF NOT EXISTS` or additive `ALTER`s, and must keep existing rows.

Add a `decisions` table; the pipeline writes the questions, the dashboard and the CLI record the answers:

| Column | Meaning |
|---|---|
| `id` | text key, stable per topic (`<repo>#<n>:<kind>` for one item, `<batch-id>` for a batch) |
| `kind` | `scope`, `duplicate`, `close`, `merge`, `split`, `other` |
| `repo`, `number` | the item; `number` null for a batch |
| `items` | JSON array of `{repo, number}` for a batch |
| `question` | one sentence |
| `context` | at most three short sentences, in user terms |
| `facts` | JSON array of up to five short facts ("+120 −8, 3 files", "author: 14 merged PRs", "reference app: Filter › Distort › Wave") |
| `options` | JSON array of `{key, label}`; 2–4 options |
| `recommended` | option key |
| `public_text` | the exact text that will be posted publicly if an option needs it, else null |
| `asked_at`, `asked_by` | when and which session or agent |
| `docket` | Docket issue key if also asked there, else null |
| `answer`, `answer_note`, `answered_by`, `answered_at` | the reader's choice; null while open |
| `applied_at` | when the pipeline acted on the answer |

A batch answer records one `answer` for the batch plus an `exceptions` JSON array of `{repo, number, answer}`.

Stage vocabulary (`stages.stage`, latest row per item wins): `classified`, `reviewed`, `take`, `hold`, `close`, `needs-decision`, `batched`, `merged`, `closed`, `fixed-by-us`. The funnel for open items, as displayed:

| Funnel step | Rule |
|---|---|
| Open | open in the mirror |
| Classified | has any `classifications` row |
| Reviewed | has a `reviewed` stage or a `sonnet` classification |
| Taken / held / to close / waiting for a decision | latest stage `take` / `hold` / `close` / `needs-decision` |
| In a batch | latest stage `batched` |
| Done | item closed or merged since the run started, split by: merged by the pipeline, closed by the pipeline, closed by others |

The run start is `settings.run_started_at`.

## Pages

### Decisions (home)

- Summary line, then filter chips (repo, kind, age) and the cards, oldest first within each group, grouped by kind then repo.
- Card: link label (`photocraft#1234`), title, the question, the facts, option buttons with the recommendation marked, an optional note field, and an expander with the context, latest classifications (one line per classifier) and related items (duplicates, linked issues, overlapping PRs).
- Batch card: the shared question, the item count, the first five items with "show all", one set of option buttons, and a per-item override in the expanded list.
- Answering a card replaces it with a one-line confirmation and an undo link (undo works until `applied_at` is set).
- "Answered" tab: decisions answered but not yet applied, then applied ones (last 7 days).

### Progress

- Org totals at the top: open now, done since run start (merged / closed), items per hour over the last 24 h, decisions open.
- Funnel chart for the org, then a table with one row per repo (sortable by open count, done count, decisions open).
- Breakdowns: type label, size bucket (S ≤ 50 changed lines, M ≤ 300, L ≤ 1,000, XL above), contributor tier.
- Trend: open items per repo per day since run start (from `items` created/closed dates).

### Repo (`/repo/<name>`)

Same blocks as Progress, filtered to one repo, plus its decisions and its batches.

### Item (`/item/<repo>/<n>`)

Title, link, author with tier, size, CI, mergeable state; the stage timeline; every classification side by side (classifier, type, want, reason); decisions about it; related items. This is where detail lives so cards can stay short.

### Contributors

Table: login, tier (whitelisted / not / override allow / override deny), merged PRs, closed unmerged, open, merge rate, last merge, repos. Filter by repo and tier; sort by any column. Allow / deny / clear buttons with an optional note. The whitelist rule (`settings.whitelist_min_merged`, `settings.whitelist_min_merge_rate`) shown and editable at the top. Notes on overrides are private.

### Classifiers

Agreement between classifiers on the same items (for the Jev vs Haiku trial, later Sonnet as the reference): per field (`type_label`, `want`), an agreement rate and a confusion matrix, with a link to the disagreeing items.

### Run and cost

Per stage and model: agent runs, items handled, tokens (input, output, cache), tokens per item. Per repo: items done and tokens spent. The experiment's headline numbers: issues and PRs closed, merged, fixed by us, by size; decisions asked and answered; items still needing a human.

## Behaviour

- Writes (answers, overrides, settings) go through POST endpoints that validate input and write one row; each records `answered_by` / `by` as the signed-in reader. Until there is sign-in, the dashboard listens on 127.0.0.1 only (the box's dev portal puts it on the private network) and records `owner`.
- The same writes are available from the CLI (`craft-auto decide <id> <option> [--note]`, `craft-auto whitelist ...`), so sessions and scripts don't scrape HTML.
- `craft-auto dash export <dir>` writes a static, read-only copy for public sharing: no write controls, no private fields (override notes, `answer_note`, anything marked private in the schema), no box paths or hostnames.

## Technology

- TypeScript on Node 24, run directly with type stripping (no build step); `node:http` and `node:sqlite`. No frontend framework; server-rendered HTML with a small amount of plain JS for filters, expanders and answering in place. No CDNs or external requests; all CSS, JS and SVG charts inline or served by the app.
- Light and dark themes via `prefers-color-scheme`; readable at 360 px wide without horizontal scrolling; touch targets at least 44 px.
- Performance at the real size (about 100,000 mirror rows including closed history, 25,000 open): every page renders in under 300 ms. Add the indexes the queries need.
- Nothing in the repo names a person other than as a GitHub login from the data, a machine, a hostname or a home directory: the repo may become public.

## Acceptance

1. A fixture generator writes data at the real scale (25,000 open items over 20 repos, 75,000 closed, 500 decisions including batches, 2,000 stage rows, 40 overrides, token rows), and every page meets the 300 ms target on it.
2. Screenshots of every page at 390 px and 1,280 px, light and dark, reviewed by eye for crowding and overflow.
3. A decision answered on the page, undone, and answered again; the same through the CLI.
4. The export contains no write controls and none of the private fields (grep for a marker placed in each private field of the fixture).
5. Tests for the funnel rules, whitelist tier precedence, and decision answer and undo.
