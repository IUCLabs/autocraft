# Triage dashboard: specification

## Purpose

The craft-app repos have about 25,000 open issues and PRs across about 20 active repos, and more arrive every day (about 900 PRs a day across the org). An automated pipeline classifies every item, reviews the promising PRs, fixes and merges what it can, and leaves the judgement calls to the maintainers.

**The bottleneck is human judgement, not tokens or build time.** The dashboard exists mainly so that maintainers can see the open decisions and make them quickly, with enough context to decide and no walls of text. Its second job is to show progress and cost, so the maintainers can trust the process and the owner can tune it.

## Readers

| Reader | Device | Wants |
|---|---|---|
| Owner (operator) | Phone first, sometimes desktop | Make decisions in bursts; see whether the run is on track; adjust the whitelist; manage who has access |
| Maintainers | Desktop and phone | Decisions in the repos they can write to; what got merged or closed and why |
| Viewers | Any | Read-only: progress, decisions and their outcomes; no answering |

Every reader signs in with GitHub. See [Accounts and access](#accounts-and-access).

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
| `summary`, `summary_by`, `summary_at` | AI summary of the item (or batch): 3–6 sentences on what it does, why, what is risky or unclear, and how it relates to the reference app; which model wrote it and when |
| `context` | at most three short sentences, in user terms |
| `facts` | JSON array of up to five short facts ("+120 −8, 3 files", "author: 14 merged PRs", "reference app: Filter › Distort › Wave") |
| `options` | JSON array of `{key, label}`; 2–4 options |
| `recommended` | option key |
| `public_text` | the exact text that will be posted publicly if an option needs it, else null |
| `asked_at`, `asked_by` | when and which session or agent |
| `docket` | Docket issue key if also asked there, else null |
| `answer`, `answer_note`, `answered_by`, `answered_at` | the operator's choice; null while open |
| `adopted_opinion` | the opinion id when the answer adopted one, else null |
| `applied_at` | when the pipeline acted on the answer |

A batch answer records one `answer` for the batch plus an `exceptions` JSON array of `{repo, number, answer}`.

A `decision_opinions` table holds opinions: `id`, `decision_id`, `login`, `option` (key, or null for a note only), `note`, `at`, `permission` (the login's GitHub permission on the repo when given: `write` or `none`), `retracted_at`. One live opinion per login and decision. Opinions are display-only and never read by the pipeline.

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
- Card: link label (`photocraft#1234`) and title, the AI summary, the issue or PR body (rendered, collapsed when long), the facts, then the question with option buttons (recommendation marked, opinion tally on each), an optional note field, everyone's opinions, and expanders with the context, latest classifications (one line per classifier) and related items (duplicates, linked issues, overlapping PRs). List rows show the item title and the summary's first sentence.
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

### Access (operators)

Access list with add, remove and role change; active sessions with revoke; the audit log, filterable by login and action.

### Run and cost

Per stage and model: agent runs, items handled, tokens (input, output, cache), tokens per item. Per repo: items done and tokens spent. The experiment's headline numbers: issues and PRs closed, merged, fixed by us, by size; decisions asked and answered; items still needing a human.

## Behaviour

- Writes (answers, overrides, settings, access) go through POST endpoints that check the reader's permission, validate input and write one row plus one audit row; each records the signed-in reader's GitHub login.
- **Decisions are answered only on the dashboard, by a signed-in person.** The CLI can ask decisions and read answers (`craft-auto decisions list --actionable`; `list` and `show` mark answers that aren't actionable and never print answer notes), but it cannot answer them: the pipeline's agents run that CLI, and an answer must always come from a person. The CLI may edit the whitelist and access list (`craft-auto whitelist ...`, `craft-auto access ...`), recorded as `cli`, because only someone with a shell on the host can run it.
- `craft-auto dash export <dir>` writes a static, read-only copy for later public sharing. Nothing serves it; publishing it is a separate decision. It has no write controls, no private fields (override notes, `answer_note`, anything marked private in the schema), and no hostnames or paths.

## Accounts and access

The whole dashboard sits behind GitHub sign-in: every page, asset and endpoint except the sign-in routes returns a redirect to sign-in (pages) or 401 (everything else) without a valid session. Nothing about the data, not even repo names or counts, is visible before sign-in.

### Who can sign in

- Only GitHub logins on the **access list** (`access` table: `login`, `role` = `operator` | `maintainer` | `viewer`, `added_by`, `added_at`, `note`). A login not on the list sees a plain "not authorised" page after GitHub's redirect, and no session is created.
- Operators add and remove logins on the Access page or with `craft-auto access add <login> [--operator|--maintainer] [--note]` / `access remove <login>`. The first operator is added with the CLI.
- Removing a login or changing its role ends its sessions at once.

### Trust boundary

The pipeline runs Claude agents under the operator's own Claude account on the operator's machine, and the operator is responsible for what they do. So nothing a dashboard user enters may steer the pipeline unless the operator has approved it, and a compromised dashboard account must not be able to cause harm.

- **Operator**: one or more logins with role `operator` (today only the owner). Only an operator's answer is **actionable**, including an answer made by adopting someone's opinion. The pipeline reads only actionable answers (`craft-auto decisions list --actionable`), and only their option keys: never free text.
- **Everyone else gives opinions.** Anyone signed in can pick an option on any decision (an **opinion**: who, which option, optional note) and comment, whatever their role or GitHub permission. Opinions are shown to everyone with the person's GitHub permission on that repo (`write` or `none`) and a tally per option. They are non-binding: the operator answers, or **adopts** an opinion with one tap, which records the operator's answer with that option and credits the opinion. A person can change or retract their opinion until the decision is answered.
- **Opinions and comments never reach the pipeline.** They are display-only: no agent prompt, brief or CLI output used by agents includes them, adopted or not.
- **Writes by non-operators are rate-limited and audited**: opinions and comments per session and per login (proposed: 60 an hour), each with an audit row.
- **`settings.maintainer_writes` is reserved** for a later deployment, on accounts and a machine meant for shared use, where an answer by a maintainer with write permission on the repo becomes actionable directly. It is off and has no effect in this deployment.
- **What a compromised account can do**: add opinions and comments, which people can see and nothing acts on. It cannot trigger a merge, close, post, label, push or any pipeline action, change the whitelist, settings or access list, or see private fields.
- **What viewers can see**: public GitHub data and the pipeline's public-safe outputs. Private fields (override notes, answer notes, anything naming why a contributor gets extra scrutiny) are operator-only and never in the export.
- **Pipeline hygiene**: agents treat all GitHub content and all dashboard text as untrusted data. Briefs quote it as data and never as instructions.

### What each person can do

| Action | Who |
|---|---|
| Read every page | anyone on the access list |
| Answer, undo, adopt an opinion | operator; for a repo decision the operator also needs write, maintain or admin permission on `storytold/R` on GitHub |
| Give, change or retract an opinion; comment on a decision | anyone signed in (rate-limited, audited); shown with their GitHub permission on the repo |
| Whitelist overrides, whitelist rule, settings (including `maintainer_writes`) | operator |
| Access list, sessions, audit log | operator |

Roles on the access list: `operator`, `maintainer`, `viewer`. Today `maintainer` and `viewer` differ only in the badge shown beside their opinions; `maintainer` gains direct answers once `maintainer_writes` is used. GitHub write permission on the repo is still required for an operator's answer about that repo.

GitHub permissions: after sign-in, read the user's permission on each repo with the user's own token (`GET /repos/storytold/<repo>` returns `permissions` for the authenticated user), cache it per user and repo for 10 minutes, and re-check at the moment of any write if the cached value is older than one minute. A user without any write permission still signs in and can give opinions. The card says in one line whether the reader's pick is an answer or an opinion.

### Sign-in flow

- A GitHub OAuth App with the authorization-code flow, `state` and PKCE. Request no scopes beyond what reading public repo permissions needs; if a private repo's permission can't be read, treat it as no write access.
- The OAuth callback URL, client id and public base URL are configuration, not code.
- Store the user's GitHub token only server-side (encrypted at rest with the session key) for permission checks; never send it to the browser or log it.

### Sessions and request safety

- Session id: 32 random bytes; cookie `HttpOnly`, `Secure`, `SameSite=Lax`, path `/`; stored in SQLite as a hash with login, created, last seen, expiry (14 days, sliding), user agent.
- Sign-out ends the session. Operators can see and revoke sessions on the Access page.
- Every POST carries a CSRF token tied to the session; reject a missing or wrong token.
- Rate-limit sign-in attempts and writes per session and per IP.
- Security headers: a strict Content-Security-Policy (self only, no inline script without a nonce), `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`.

### Audit log

`audit` table: `at`, `login`, `action` (`answer`, `undo`, `adopt`, `opinion`, `opinion-retract`, `comment`, `override`, `rule`, `access-add`, `access-remove`, `session-revoke`, `sign-in`, `sign-in-refused`), `target`, `details` (JSON). Shown on the item page (that item's entries) and on the Access page (everything, filterable).

### Secrets and configuration

- The OAuth client secret and the session key are never in the repo, in logs or in error pages. The server reads them from a file named by `CRAFT_AUTO_SECRETS_FILE` (mode 0600, JSON) and refuses to start if it's missing, readable by others, or incomplete.
- Other configuration (base URL, listen address, port, database path) comes from environment variables, documented in the README with no values specific to one machine.

### Hosting for now

The server listens on 127.0.0.1 only; a private network proxy in front of it provides HTTPS. GitHub sign-in applies there too, so moving to a public host later changes only the configuration.

### Testing without GitHub

A fake OAuth provider for tests and local development, enabled only when `CRAFT_AUTO_DEV_AUTH=1` **and** the server listens on a loopback address; it signs in as a login given in the test and serves configurable repo permissions. The server refuses to start with dev auth on any other address.

## Technology

- Server: TypeScript on Node 24, run directly with type stripping (no build step); `node:http` and `node:sqlite`. It serves the JSON API under `/api/`, the sign-in routes under `/auth/`, and the frontend.
- Frontend: a React app in `web/` (Vite, Tailwind, Radix primitives), described in `docs/ui-design.md`. `pnpm -C web build` writes it to `web/dist`, which the server serves behind sign-in: hashed files under `/assets/` with a year's cache, and `index.html`, uncached, for every other path, so the app routes on the client. It talks to the server only through the JSON API.
- The pages the app doesn't have yet (Contributors, Repos, Access) are server-rendered HTML with a little plain JS, at their own paths; the app's sidebar links to them.
- Content-Security-Policy: the app gets `script-src 'self'` and `style-src 'self'` plus the hash of the one fixed `<style>` the Radix dialog's scroll lock injects; server-rendered pages use a per-response nonce. `img-src` is `'self' data:`. No CDNs or external requests from the browser: all CSS, JS, fonts and charts are served by the app, and GitHub-hosted images in bodies and comments come through the server's image proxy, `GET /img?u=<url>`. The proxy needs a session, fetches only an allow-list of GitHub image hosts and path shapes (redirects re-checked against it), sends the bot's token only to `github.com`, serves only raster image types (no SVG) under a size cap, timeout and per-session rate limit, with `default-src 'none'` and `nosniff`; the README lists its rules.
- Light and dark themes via `prefers-color-scheme`; readable at 360 px wide without horizontal scrolling; touch targets at least 44 px.
- Performance at the real size (about 100,000 mirror rows including closed history, 25,000 open): every page renders in under 300 ms. Add the indexes the queries need.
- Nothing in the repo names a person other than as a GitHub login from the data, a machine, a hostname or a home directory: the repo may become public.

## Acceptance

1. A fixture generator writes data at the real scale (25,000 open items over 20 repos, 75,000 closed, 500 decisions including batches, 2,000 stage rows, 40 overrides, token rows), and every page meets the 300 ms target on it.
2. Screenshots of every page at 390 px and 1,280 px, light and dark, reviewed by eye for crowding and overflow.
3. A decision answered on the page, undone, and answered again.
4. The export contains no write controls and none of the private fields (grep for a marker placed in each private field of the fixture).
5. Access, with the fake provider: every route without a session redirects or returns 401; a login not on the access list gets no session; a viewer can read but every write returns 403; a maintainer can answer only decisions in repos where the fake provider grants write; a batch spanning a repo without write is refused; a POST without the CSRF token is refused; removing a login ends its session; the server refuses to start with dev auth on a non-loopback address or with a world-readable secrets file.
6. Tests for the funnel rules, whitelist tier precedence, decision answer and undo, and the access checks in item 5.
