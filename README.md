# craft-automation

Local mirror of every storytold issue and PR, the triage pipeline's state, and the backlog dashboard.

- `craft-auto sync` fills a SQLite mirror (`~/.local/share/craft-automation/mirror.db`, or `$CRAFT_AUTO_DB`) from GitHub GraphQL. Agents and scripts query the mirror instead of calling `gh`.
- `craft-auto whitelist` shows and edits which contributors' PRs may merge on green CI without a decision.
- `craft-auto decide` turns items that need a maintainer's scope call into dashboard decisions, each with an AI summary (`docs/pipeline.md`, Scope decisions).
- `craft-auto labels ensure|plan|apply --repo R` is the pipeline's Label stage: puts each item's settled type label and flags on GitHub. `plan` and dry runs only read; `apply --apply` writes, and only for repos an operator approved on the dashboard Repos page. See docs/pipeline.md.
- `craft-auto dash serve` serves the dashboard.
- `craft-auto runner serve` runs the pipeline: while the pipeline is On (switch on the dashboard's Pipeline page, or `craft-auto pipeline on`), it queues and runs the steps that have work, within each stage's daily limit. Turning it Off cancels queued automatic jobs; running ones finish.
- `craft-auto review --repo R [--limit N] [--dry-run]` runs the Review stage on one repo; `craft-auto checks --repo R` refreshes CI and merge state of its open PRs. See docs/pipeline.md, stage 5.
- `craft-auto merge --repo R [--limit N] [--apply]` merges the repo's queued PRs that may merge, through `$CRAFT_AUTO_MERGE_CMD` (default `safe-merge`), and asks a Merge? decision for the other taken PRs; without `--apply` it is a dry run. `craft-auto queue [--repo R]` prints the merge queue. The runner's `merge` step and the autopilot merge only in repos an operator approved for merging on the Repos page. See docs/pipeline.md, stage 6.
- Runner steps (`craft-auto runner steps`): `classify-new`, `classify-all`, `embed`, `labels-ensure`, `labels-apply`, `decide`, `review-batch`, `checks` and `merge` (operator only, group `github-write`, params `repo` and `limit`; it runs the merge command with `--apply`, so it merges for real).

### Sync

`craft-auto sync` (every minute) runs one org-wide GitHub search for items updated since the newest `updatedAt` stored (`org_high_water`) minus 120 seconds, up to the run's start. The search returns at most 1,000 results, so a window with more matches is cut into `updated:A..B` slices, halving until each fits; there is no per-repo fallback. GitHub's search index can lag several minutes, so once an hour (`search_catchup_at`) the same search also re-reads the 30 minutes before `org_high_water`, sliced the same way. `org_high_water` moves to the newest `updatedAt` seen, not to the start time. Items of untracked repos are dropped before anything else is done with them. Per-repo passes run only for the first sync and for `--per-repo`, `--all` and `--repo`.

`craft-auto sync --full` re-reads every item of every tracked repo. It has its own lock (`sync-full-<db>.lock`), so the minute sync keeps running; before each request it waits while a minute sync runs, and it sleeps until the rate limit resets when fewer than 2,500 points are left (`--keep N`). It records the last finished repo (`full_sync_cursor` in `settings`) and a stopped run continues after it; `--restart` starts over.

Each run stores `sync_points_last_run` (a full run: `sync_full_points_last_run`) and `sync_rate_remaining` in `settings`.

Sync also stores the hashes the planner compares, on the item row: `embed_hash` (the embedded text, `src/embed/text.ts`) and `class_hash` with `class_scheme` (the classifier's input hash, `src/itemhash.ts`). `classify-new` and `embed` select changed items from these columns on covering indexes instead of hashing every body. The first `connect()` after an upgrade fills them for existing rows (about 6 s for 56,000 items). An edit of title, body or size outside sync clears the row's hashes, and the readers fill them again.

Schema: `src/schema.sql`. Full-text search uses the FTS5 tables `items_fts` and `comments_fts`, kept current by triggers; the first `connect()` after an upgrade builds them (about 16 s for 56k items and 65k comments). Mirror tables are overwritten by sync; work tables (classifications, stages, whitelist overrides, token use) are ours.

TypeScript on Node 24, run directly (type stripping, no build step): `node src/cli.ts <command>`. SQLite through the built-in `node:sqlite`. `pnpm check` type-checks; `pnpm test` runs the tests.

## Dashboard server

`craft-auto dash serve` serves the dashboard over plain HTTP; a proxy in front provides HTTPS. Every page needs GitHub sign-in, and only logins on the access list get a session. Roles are `operator` (answers decisions, manages the whitelist, repos and access), `maintainer` and `viewer` (both read and give opinions). Add the first operator from a shell: `craft-auto access add <login> --operator`. Then manage the list on the Access page or with `craft-auto access list|add|remove|role`.

The frontend is the React app in `web/`. Build it before serving: `pnpm -C web install && pnpm -C web build` (writes `web/dist`). Without a build the server answers app pages with a 503 that says so. `VITE_MOCK=1 pnpm -C web build` builds a mockup on fake data that runs without the server.

| Variable | Meaning |
|---|---|
| `CRAFT_AUTO_BASE_URL` | Public origin of the dashboard, such as `https://dashboard.example.org` (no path). The OAuth App's callback URL must be exactly `<CRAFT_AUTO_BASE_URL>/auth/callback`. Required unless dev auth is on. |
| `CRAFT_AUTO_LISTEN` | `host:port` to listen on. Default `127.0.0.1:8993`; with dev auth, `127.0.0.1:8994`. |
| `CRAFT_AUTO_DB` | SQLite database path (the mirror database). |
| `CRAFT_AUTO_WEB_DIST` | Directory of the built frontend. Default `web/dist` in the repo. |
| `CRAFT_AUTO_SECRETS_FILE` | JSON file with `github_client_id`, `github_client_secret` and `session_key` (at least 32 characters, random). Must be mode 0600; the server refuses to start if it is missing, incomplete, or readable by group or others. |
| `CRAFT_AUTO_TRUST_PROXY` | `1` to take the client address for rate limits from the last `X-Forwarded-For` entry. Set it only behind a proxy that sets that header. |
| `CRAFT_AUTO_IMG_CACHE` | Disk cache of the image proxy. Default `$XDG_CACHE_HOME/craft-automation/img` (`~/.cache/...`); empty for no disk cache. |

The GitHub OAuth App needs no scopes, and expiring user tokens are supported: the server refreshes them as needed and ends the session when a refresh fails. Tokens are stored encrypted with a key derived from `session_key`; changing `session_key` ends every session.

### Images

`GET /img?u=<url>` (signed in only) fetches GitHub-hosted images from issue and PR bodies so the app can show them inline under its CSP. It serves only `https` URLs on `github.com/user-attachments/assets/<uuid>`, `private-user-images.githubusercontent.com`, `user-images.githubusercontent.com`, `raw.githubusercontent.com/storytold/` and `avatars.githubusercontent.com`; everything else is a 404. It follows at most three redirects, each to one of those hosts or GitHub's attachment bucket (`github-production-user-asset-6210df.s3.amazonaws.com`). Requests to `github.com` carry the bot's token from `gh auth token`, run in the repo's directory and kept in memory for an hour; no other host gets it. It serves PNG, JPEG, GIF, WebP and AVIF, checked by their magic bytes, up to 15 MB, within 15 seconds; never SVG. Responses are `private, max-age=86400` with `default-src 'none'` and `nosniff`; images are cached on disk for 7 days (at most 512 MB), and each session may make 120 upstream fetches a minute.

### Development sign-in

With `CRAFT_AUTO_DEV_AUTH=1` the server uses a fake GitHub: `/auth/signin` shows a form that signs in as any login typed into it (the login must still be on the access list). It needs no secrets file and starts only on a loopback listen address (default port 8994). If `CRAFT_AUTO_BASE_URL` is set it must be an `http://localhost` or `http://127.0.0.1` URL. The server answers 403 to any request that carries `X-Forwarded-For` or a `Host` that is not a loopback name. Repo permissions come from the JSON file named by `CRAFT_AUTO_DEV_PERMS`, read on every check: `{"<login>": {"<repo>": "write"}}` (values `admin`, `maintain`, `write`, `triage`, `read`). `CRAFT_AUTO_DEV_TOKEN_TTL` sets the fake access tokens' lifetime in seconds (default 8 hours). Open the dashboard as `http://localhost:<port>` so the browser accepts its `Secure` cookies.

### JSON API

The frontend in `web/` talks to `/api/`; the wire types are `web/src/api/types.ts`. Every endpoint needs a session (401 JSON without one) and returns errors as `{"error": "..."}` with a status code. Every `/api/` response carries the session's CSRF token in `X-CSRF-Token`; every POST must send it back in the same header, with a JSON body (at most 64 KB). A POST whose `Origin` or `Sec-Fetch-Site` names another site is refused.

| Method and path | Who |
|---|---|
| `GET /api/me`, `/api/repos`, `/api/progress`, `/api/search?q=`, `/api/items/<repo>/<n>` | anyone signed in |
| `GET /api/items?q=&mode=text&repo=&kind=&state=&label=&status=&flag=&author=&since=&flow=&sort=&desc=&limit=&offset=&run=` (Items browser: full-text search over titles, bodies and comments, settled type labels, counts per settled status; `flow=<node>.<branch>` lists exactly the items a flowchart branch counts) | anyone signed in |
| `GET /api/classifiers?run=&a=&b=` (agreement, confusion, confidence bands and flags for a run and classifier pair; defaults to the latest run), `/api/classifiers/disagreements?run=&a=&b=&label=&band=&limit=&offset=` | anyone signed in |
| `GET /api/cost?run=` (token use, USD where recorded, and wall time per stage and model and per repo, plus spend over time; all runs when `run` is empty) | anyone signed in |
| `GET /api/flow?repo=` (the home page flowchart: stages with branch counts, edges, the last 24 hours, runner steps and prompts per stage, from the per-repo `flow_summary` rows) | anyone signed in |
| `GET /api/queue?repo=&state=` (the merge queue: taken PRs, their state, counts per state) | anyone signed in |
| `GET /api/prompts` (every registered model prompt: template, model, call settings, output checks and a rendered example on made-up items, plus the commit the server runs) | anyone signed in |
| `GET /api/decisions?status=open\|opinions\|answered&repo=&kind=&minAge=&mine=1&limit=&offset=`, `/api/decisions/<id>`, `/api/decisions/<id>/thread` | anyone signed in; answer notes only for operators |
| `POST /api/decisions/<id>/answer` `{answer, note?, exceptions?}`, `/undo`, `/adopt` `{opinionId}` | operator with write, maintain or admin on every repo the decision covers |
| `POST /api/decisions/<id>/opinion` `{option, note?}`, `/retract`, `/comments` `{body}` | anyone signed in; audited; non-operators get 60 an hour per login |
| `POST /api/decisions/<id>/claim` | anyone signed in: marks the decision as being looked at for 10 minutes |
| `GET /api/contributors?q=&tier=&repo=&sort=&desc=&limit=&offset=` | anyone signed in; override notes only for operators |
| `GET /api/contributors/rule-preview?minMerged=&minRate=`; `POST /api/contributors/rule` `{minMerged, minRate}`, `/api/contributors/<login>/override` `{status: "allow"\|"deny"\|null, note?}` | operator |
| `GET /api/repos/all`; `POST /api/repos/track` `{name}`, `/api/repos/untrack` `{name}` | operator |
| `GET /api/access`, `/api/audit?login=&action=&limit=&offset=`; `POST /api/access/add` `{login, role, note?}`, `/api/access/remove` `{login}`, `/api/access/role` `{login, role}`, `/api/access/sessions/revoke` `{id}` | operator; the last operator can't be removed or demoted |
| `GET /api/pipeline` (stages, steps with their params schema and last job, runner heartbeat, recent syncs), `/api/pipeline/state` (switch, who and when, per-stage daily limits with use today), `/api/pipeline/jobs?step=&state=&limit=&offset=`, `/api/pipeline/jobs/<id>` (with the scrubbed end of its log) | anyone signed in |
| `POST /api/pipeline/jobs` `{step, params}`, `/api/pipeline/jobs/<id>/cancel`, `PUT /api/pipeline/state` `{enabled}`, `/api/pipeline/limits/<step>` `{perDay: number\|null}` | operator; audited |
| `GET /api/accounts` (Claude accounts with label, slots in use and usage; maintainers and viewers see enabled ones only), `/api/agents?state=&step=&account=&repo=&cursor=&limit=` (agent runs, newest first, keyset cursor; `state=running` lists every active run), `/api/agents/<id>` (with prompt and output while within 14 days), `/api/rates?window=24h\|7d` (items moved and agent runs per stage, account usage over time) | anyone signed in |
| `PUT /api/accounts/<id>` `{label?, enabled?, maxConcurrent?}` | operator; audited as `account-change` |
| `POST /api/signout` | anyone signed in |
| `GET /api/similar/<repo>/<n>?limit=` (nearest items across the tracked repos, with score; default 10, at most 50), `/api/search?q=&mode=semantic` (search by meaning, same hits plus a score) | anyone signed in; 503 until `craft-auto embed` has run |

Opinions and comments are display-only. The pipeline reads answers with `craft-auto decisions list --actionable` (one JSON object per line: option keys of unapplied answers by a current operator), which never includes them.

## Pipeline runner

`craft-auto runner serve` is the only process that runs pipeline steps (how the parts fit together: [docs/pipeline.md](docs/pipeline.md#architecture)). It polls the `jobs` table every 2 seconds, runs each job in a child process (`craft-auto runner exec <id>`) with its output in a log file, stops jobs whose cancel was requested, and, while the pipeline is On, queues the jobs the stages need (see [docs/pipeline.md](docs/pipeline.md#on-and-off)). Every 20 seconds it also refreshes the flowchart counts (`flow_summary`) of repos whose data changed. On start it marks jobs that an earlier runner left running as failed. A lock file keeps a second runner on the same database from starting.

It reads the same variables as the CLI (`CRAFT_AUTO_DB` and the rest), plus:

| Variable | Meaning |
|---|---|
| `CRAFT_AUTO_RUNNER_LOGS` | Directory of the per-job log files. Default `~/.cache/craft-automation-logs/jobs`. The dashboard reads each job's log from the path recorded in its row, so it must run as a user who can read this directory. |
| `CRAFT_AUTO_RUNNER_JOBS` | Most jobs running at once. Default 8, enough for every concurrency group to have a job running; jobs of one group always run one at a time. |
| `CRAFT_AUTO_RUNNER_POLL_MS` | Poll interval. Default 2000. |
| `CRAFT_AUTO_LOCK_DIR` | Directory of the lock file, shared with `sync`. Default `~/.cache/craft-automation-logs`. |
| `CRAFT_AUTO_EXTRA_STEPS` | A module exporting `steps: StepDef[]` that is added to the step list, for tests and development (`test/runner-steps.ts` has fake steps). Set it for the dashboard and the runner alike, or not at all. |

The classify steps call `jev` and `claude`, so the runner's `PATH` must reach them.

To run it as a systemd user service, fill in the placeholders of `deploy/craft-runner.service`, copy it to `~/.config/systemd/user/`, and run `systemctl --user daemon-reload && systemctl --user enable --now craft-runner`. Stopping the service stops running jobs; they show as failed and can be started again.

From a shell: `craft-auto pipeline on|off|status` flips the switch and `pipeline limit <step> --per-day N|none` sets a stage's daily limit (both recorded as `cli`). `craft-auto runner steps` lists steps and their params, `runner enqueue <step> [--<param> <value> ...]` queues a job by hand for debugging (recorded as `cli`), `runner jobs [--state S]` lists jobs, `runner cancel <id>` cancels one.

### Claude accounts

Claude calls run under accounts that an operator enabled. Which accounts exist on a machine comes from files outside the repository, named by environment variables that the runner, the dashboard and the CLI all read:

| Variable | Meaning |
|---|---|
| `CRAFT_AUTO_ACCOUNTS` | A JSON file `[{ "id": "b", "configDir": "/path/to/claude-config-b" }]`. `id` is a short key (lowercase letters, digits, `_`, `-`); `configDir` becomes `CLAUDE_CONFIG_DIR` of the `claude` child process of calls made on that account. Directories never appear in the API, the logs or the UI. |
| `CRAFT_AUTO_USAGE_DIR` | A directory with one file per account id, `<id>.json`: `{ "written_at": <unix s>, "rate_limits": { "five_hour": { "used_percentage": n, "resets_at": <unix s> }, "seven_day": { ... } } }`. Only that file is read. |
| `CRAFT_AUTO_USAGE_REFRESH` | Optional command (split on spaces, no shell) that the runner runs every 5 minutes to refresh the readings. |

Example: `CRAFT_AUTO_ACCOUNTS=/path/to/accounts.json`, `CRAFT_AUTO_USAGE_DIR=/path/to/usage`, `CRAFT_AUTO_USAGE_REFRESH="/path/to/refresh-usage --all"`.

Each account in the file gets a row (disabled, labelled with its id) the first time anything lists accounts. Operators set the label, the switch and the number of calls at once on the Accounts page or with `craft-auto accounts list` and `craft-auto accounts set <id> [--label X] [--enabled yes|no] [--max-concurrent N]` (1 to 100; recorded as `cli`). Jev has no accounts; its calls at once are the `jev_parallel` setting (default 4), changed with `craft-auto accounts jev [N]`. Claude calls in flight are limited only by the accounts' free slots. Allocation and pauses are described in [docs/pipeline.md](docs/pipeline.md#claude-accounts-and-agent-runs).

### Adding a step

A step is one entry in `STEPS` in `src/runner/steps.ts`:

```ts
{
  name: "review-batch",
  title: "Review PRs",
  description: "Sonnet reviews the open PRs of one repo that are marked for review.",
  stage: 5,                      // docs/pipeline.md stage
  requires: "operator",
  group: "review",               // one job of a group at a time; groups: classify, decide, review, github-write, github-read, local
  params: [
    { name: "repo", label: "Repo", kind: "repo", required: true },
    { name: "limit", label: "At most", kind: "int", min: 1, max: 50, default: 10 },
  ],
  run: async (ctx) => (await import("../review/step.ts")).reviewBatch(ctx),
}
```

A step lists the models it calls in `models` (a list, or a function of the params, as `decide` does), so the Pipeline page shows them before any call is made. Model calls go through `askClaude` and `askJev` in `src/classify/run.ts`, which allocate the account and record the agent run; a step does neither itself.

Param kinds are `enum`, `repo` (a tracked repo), `int` and `run-id`; there is no free-text kind, so nothing typed on the dashboard reaches a prompt. `run` gets the database, the validated params, `progress(text)`, `log(line)`, `handled(n)` (the running total of units the job has attempted, saved at once and counted against the stage's daily limit), `usageRun(runId)` (token use recorded under that run from the job's start counts as the job's) and `cancelled()`, and returns a one-line summary; throwing fails the job with the error's message. `available()` and `check(db, params)` can refuse a step or a request with a reason. The Pipeline page, the API, the autopilot and the CLI pick the step up from the list.

## Similar items and semantic search

`craft-auto embed [--all] [--threads N] [--batch N]` embeds every tracked item whose text changed since its last embedding (`--all`: every tracked item) into `item_embeddings`, and removes vectors of items that left the mirror or the tracked repos. Each batch commits on its own, so an interrupted run continues where it stopped. The dashboard reads the table for "Similar items" on the Item page and for the search box's meaning toggle; it embeds search queries, and items without a vector yet, itself.

- Model: [bge-small-en-v1.5](https://huggingface.co/BAAI/bge-small-en-v1.5) (384 dimensions, int8 ONNX from `Xenova/bge-small-en-v1.5`), run on the CPU through `@huggingface/transformers`. The first use downloads it (34 MB) from Hugging Face.
- Text: the title, a newline, then the first 1,000 characters of the body with HTML comments, code blocks, images, URLs and Markdown markup removed (`src/embed/text.ts`); at most 256 tokens. Its hash decides whether an item is embedded again.
- Vectors are float32 and unit length; the server keeps them in memory, reloads them when the table changes, and ranks by dot product (cosine similarity).

| Variable | Meaning |
|---|---|
| `CRAFT_AUTO_MODEL_CACHE` | Where model files are kept. Default `$XDG_CACHE_HOME/craft-automation/models` (`~/.cache/...`). |
| `CRAFT_AUTO_EMBED_MODEL` | `bge-small-en-v1.5` (default), `multilingual-e5-small` or `all-MiniLM-L6-v2`. Changing it makes the next `embed` run embed everything again. |
| `CRAFT_AUTO_EMBED_THREADS` | CPU threads for `embed` (default and maximum 8). The server uses 2. |
