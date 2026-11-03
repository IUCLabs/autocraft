# craft-automation

Local mirror of every storytold issue and PR, the triage pipeline's state, and the backlog dashboard.

- `craft-auto sync` fills a SQLite mirror (`~/.local/share/craft-automation/mirror.db`, or `$CRAFT_AUTO_DB`) from GitHub GraphQL. Agents and scripts query the mirror instead of calling `gh`.
- `craft-auto whitelist` shows and edits which contributors' PRs may merge on green CI without a decision.
- `craft-auto decide` turns items that need a maintainer's scope call into dashboard decisions, each with an AI summary (`docs/pipeline.md`, Decide).
- `craft-auto labels ensure|plan|apply --repo R` is the pipeline's Label stage: puts each item's settled type label and flags on GitHub. `plan` and dry runs only read; `apply --apply` writes, and only for repos an operator approved on the dashboard Repos page. See docs/pipeline.md.
- `craft-auto dash serve` serves the dashboard.
- `craft-auto runner serve` runs the pipeline: while the pipeline is On (switch on the dashboard's Pipeline page, or `craft-auto pipeline on`), it queues and runs the steps that have work, within each stage's daily limit. Turning it Off cancels queued automatic jobs; running ones finish.
- `craft-auto review --repo R [--limit N] [--dry-run]` runs the Review stage on one repo; `craft-auto checks --repo R` refreshes CI and merge state of its open PRs. See docs/pipeline.md, Review.
- `craft-auto merge --repo R [--limit N] [--apply]` merges the repo's queued PRs that may merge, through the built-in `craft-auto safe-merge` (`$CRAFT_AUTO_MERGE_CMD` overrides it with another command), and asks a Merge? decision for the other taken PRs; without `--apply` it is a dry run. `craft-auto queue [--repo R]` prints the merge queue. The runner's `merge` step and the autopilot merge only in repos an operator approved for merging on the Repos page. See docs/pipeline.md, Merge queue.
- Runner steps (`craft-auto runner steps`): `classify-new`, `classify-all`, `embed`, `labels-ensure`, `labels-apply`, `decide`, `review-batch`, `checks` and `merge` (operator only, group `github-write`, params `repo` and `limit`; it runs the merge command with `--apply`, so it merges for real).

### Sync

`craft-auto sync` (every minute) runs one org-wide GitHub search for items updated since the newest `updatedAt` stored (`org_high_water`) minus 10 minutes, up to the run's start. The search returns at most 1,000 results, so a window with more matches is cut into `updated:A..B` slices, halving until each fits. A one-second slice with more than 1,000 matches is read by listing every tracked repo down to that second (with a logged warning); until the run finishes, neither `org_high_water` nor a repo's `high_water` moves. GitHub's search index can lag, so once an hour (`search_catchup_at`) the same search also re-reads the 6 hours before `org_high_water`, sliced the same way. `org_high_water` moves to the newest `updatedAt` seen, not to the start time. An item whose stored row equals what GitHub returned is not written again. Items of untracked repos are dropped before anything else is done with them. Per-repo passes run only for the first sync, for a repo that was just tracked (tracking clears its `high_water` and `synced_at`) and for `--per-repo`, `--all` and `--repo`.

Once a day per tracked repo (`repos.reconciled_at`; each run takes the repo with the oldest one, if it is over 24 hours old) the sync lists the repo's open issues and PRs. Mirror rows still `OPEN` that GitHub does not list as open are read one by one: closed or merged ones are updated, and ones GitHub no longer finds (deleted) or reports in another repo (transferred) are set to `CLOSED` and written to the audit log as `item-gone`.

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

`GET /img?u=<url>` (signed in only) fetches GitHub-hosted images from issue and PR bodies and comments so the app can show them inline under its CSP. It serves only `https` URLs on `github.com/user-attachments/assets/<uuid>`, `private-user-images.githubusercontent.com`, `user-images.githubusercontent.com`, `raw.githubusercontent.com/storytold/` and `avatars.githubusercontent.com`, and only when the exact URL occurs in a mirrored body or comment of a tracked repo; everything else is a 404 with no upstream request. The set of such URLs is rebuilt from the mirror when it has changed (at most every 30 seconds), and a cached image is served only while its URL is still in it. `imageRepo(url)` in `src/dash/server/images.ts` returns the repo an allowed URL belongs to.

The proxy follows at most three redirects, each to one of those hosts or GitHub's attachment bucket (`github-production-user-asset-6210df.s3.amazonaws.com`); IP addresses and `localhost` are never fetched. It serves PNG, JPEG, GIF, WebP and AVIF, checked by their magic bytes, up to 5 MB (the stream is aborted past that), within 15 seconds; never SVG. At most 4 upstream fetches run at once; further ones wait up to 5 seconds, then get 429. Each session may make 120 upstream fetches a minute and each client address 240. Responses are `private, max-age=86400` with `default-src 'none'` and `nosniff`; images are cached on disk for 7 days (at most 512 MB).

Requests to `github.com` attachment URLs carry a GitHub token; no other host gets it. The token comes from `CRAFT_AUTO_IMAGE_TOKEN_FILE` when it is set: a file holding a token that can read the tracked repos and nothing more (a fine-grained read-only token). The file is read at start and again when it changes. When the variable is unset, the server runs `gh auth token` in the repo's directory instead. The server logs which source it uses at start, never the value.

| Variable | Meaning |
|---|---|
| `CRAFT_AUTO_IMAGE_TOKEN_FILE` | File with the image proxy's token. Default: unset, use `gh auth token`. |

### Request limits

The GET endpoints that do real work (`/api/queue`, `/api/contributors`, `/api/search?mode=semantic`) share a per-session token bucket of 20 requests refilling at one every two seconds; beyond it the answer is 429 with `Retry-After`. At most two embeddings run at once; others wait up to 3 seconds, then get 429. The contributors table is computed at most once a minute, and after that until the next sync moves the high-water mark.

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
| `GET /api/repos/all`; `POST /api/repos/track` `{name}`, `/api/repos/untrack` `{name}`, `/api/repos/pipeline-on` `{name}`, `/api/repos/pipeline-off` `{name}` | operator |
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

### Build environments and the worker API

The runner also serves the worker API on its own listener, for workers that run untrusted code (concept and trust rules: [docs/pipeline.md](docs/pipeline.md#build-environments-and-tasks)). It is separate from the dashboard; expose it to remote workers only behind TLS (for example a tailnet-only proxy).

| Variable | Meaning |
|---|---|
| `CRAFT_AUTO_WORKER_LISTEN` | `host:port` of the worker API. Default `127.0.0.1:8981`. If it cannot listen, the runner logs the error and carries on. |
| `CRAFT_AUTO_ARTIFACT_DIR` | Where task artifacts are stored. Default `artifacts` beside the database. The runner and the dashboard must both see it. |

Every call carries `Authorization: Bearer <worker key>`, which identifies the environment and refreshes its heartbeat. JSON bodies are sent as `application/json`.

| Call | Body | Answer |
|---|---|---|
| `POST /worker/hello` | `{ version, capabilities, slots }` | `{ envId, label, slots }` (slots capped by the operator's setting) |
| `POST /worker/claim` | `{ free, pausedReason }` | `{ tasks: [{ id, repo, headSha, baseSha, requires, plan, sourceUrl }], cancel: [ids] }` |
| `POST /worker/tasks/:id/start` | none | `{ cancel }` |
| `POST /worker/tasks/:id/log` | `{ step, chunk }`, chunk at most 64 KB | `{ truncated }` |
| `PUT /worker/tasks/:id/artifacts/:name` | raw bytes, at most 50 MB; the name is 1 to 100 of letters, digits, `.`, `_`, `-` | `{ bytes, contentType }` |
| `POST /worker/tasks/:id/finish` | `{ results: [{ step, exitCode, durationMs, timedOut }], summary }` | `{ state }`; retries return the same answer |
| `POST /worker/tasks/:id/heartbeat` | none (every 15 s while running) | `{ cancel }` |

`claim` with `free: 0` is allowed and refreshes the heartbeat and the paused reason. The task is `done` when every step exited 0 without a timeout, otherwise `failed` (empty results too). Errors are `{ "error": text }` with status 400 (bad body), 401 (key), 409 (the task is not running on this environment), 413 (size cap), 415 (artifact type), 429 (rate limit; `Retry-After`).

Operators manage environments on the Build environments page (`/envs`) or from a shell (recorded as `cli`). A worker key is written to a file with mode 0600 and printed only with `--print`:

```
craft-auto envs list
craft-auto envs add <id> --label TEXT --kind local-sandbox|remote --slots N (--out FILE | --print)
craft-auto envs set <id> [--label TEXT] [--enabled yes|no] [--slots N]
craft-auto envs rotate-key <id> (--out FILE | --print)
craft-auto tasks list [--state S] [--env ID] [--repo NAME] [--limit N]
craft-auto tasks show <id>
craft-auto tasks cancel <id>
craft-auto tasks enqueue-test --env-requires linux --repo NAME --sha SHA
```

`tasks enqueue-test` queues a harmless smoke test for a tracked public repo (`uname -a; nproc; free -g` with no network, then `cargo --version`).

### Claude accounts

Claude calls run under accounts that an operator enabled. Which accounts exist on a machine comes from files outside the repository, named by environment variables that the runner, the dashboard and the CLI all read:

| Variable | Meaning |
|---|---|
| `CRAFT_AUTO_ACCOUNTS` | A JSON file `[{ "id": "b", "configDir": "/path/to/claude-config-b" }]`. `id` is a short key (lowercase letters, digits, `_`, `-`); `configDir` becomes `CLAUDE_CONFIG_DIR` of the `claude` child process of calls made on that account. Directories never appear in the API, the logs or the UI. |
| `CRAFT_AUTO_USAGE_DIR` | A directory with one file per account id, `<id>.json`: `{ "written_at": <unix s>, "rate_limits": { "five_hour": { "used_percentage": n, "resets_at": <unix s> }, "seven_day": { ... } } }`. Only that file is read. |
| `CRAFT_AUTO_ACCOUNTS_ROOT` | Directory for the config directories of accounts added on the Accounts page (`<root>/<id>`, mode 0700). Without it, accounts can only come from the file. |
| `CRAFT_AUTO_CLAUDE_BIN` | The `claude` command used for sign-in, status and usage (default: `claude` on the PATH). |

Example: `CRAFT_AUTO_ACCOUNTS=/path/to/accounts.json`, `CRAFT_AUTO_USAGE_DIR=/path/to/usage`, `CRAFT_AUTO_ACCOUNTS_ROOT=/path/to/accounts`.

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

## Running a worker

A worker runs untrusted build tasks for the coordinator (the runner process). It holds no GitHub token, no Claude login and no database access: it downloads public source tarballs anonymously, runs each plan step in a fresh container, and sends logs, results and artifacts back, all of which the coordinator treats as untrusted data.

```
craft-auto worker serve [--config FILE]     # default: $CRAFT_AUTO_WORKER_CONFIG
```

### Local sandbox user

Run the worker as a separate OS user without access to the operator's home, tokens or Claude login, with rootless Podman, from its own checkout of this repository. Create the environment on the Build environments page (or `POST /api/envs`); the key is shown once. Save it to a file readable only by the sandbox user, and write the config:

```json
{
  "coordinatorUrl": "http://127.0.0.1:8981",
  "keyFile": "/home/sandbox/.config/craft-worker/key",
  "workDir": "/home/sandbox/work",
  "slots": 2,
  "images": { "rust-stable": "docker.io/library/rust@sha256:<digest>" },
  "runtime": "podman",
  "limits": { "cpus": 4, "memoryGb": 8, "pids": 1024, "minFreeDiskGb": 20 },
  "fetchNetwork": "pasta",
  "display": false,
  "gpu": false
}
```

Only `coordinatorUrl`, `keyFile` and `workDir` are required. `workDir` must not contain commas, colons or spaces. Other keys: `userns` (default `keep-id`), `maxSourceMb` (300), `maxStepSec` (14400), `warmDir` (default `<workDir>/../warm`, same path rules as `workDir`) and `warmMaxGb` (60).

Then install `deploy/craft-worker.service` as a systemd user unit of the sandbox user (the file's header lists the steps).

### Toolchain images

`images` maps a toolchain name (what tasks `require`) to an image. The defaults are `rust-stable` = `docker.io/library/rust:1-bookworm` and `node-24` = `docker.io/library/node:24-bookworm`. Tags move, so pin each image to a digest:

```
podman pull docker.io/library/rust:1-bookworm
podman image inspect --format '{{index .RepoDigests 0}}' docker.io/library/rust:1-bookworm
```

Put the printed `...@sha256:...` reference into `images`. The reported capabilities list the keys of `images`. A task that requires several toolchains runs in the first one that has an image.

### What a step runs in

Every step is `podman run --rm` with: `--network none` (the `fetchNetwork` for steps marked `fetch`), `--read-only` root with a 2 GB tmpfs on `/tmp`, `--cap-drop all`, `--security-opt no-new-privileges`, `--userns keep-id`, `--cpus`, `--memory` (swap equal), `--pids-limit`, and four mounts: `/src` (the source as an overlay: steps may write next to the sources, as tests in a CI checkout can, and the writes are dropped when the step ends), `/target` (build output), `/cache` (CARGO_HOME) and `/out` (artifacts). No other mounts and no environment from the host. A step that exceeds its timeout is killed and recorded as timed out; a failing step ends the plan. The work dir and containers are removed after each task and at worker start.

The disk check runs before every claim: below `minFreeDiskGb` (20) free on the work dir's file system, the worker claims nothing and reports `disk N GB free (needs 20)` as its paused reason.

### Patches and warm target dirs

A claimed task may carry `patch`, a git-format unified diff of at most 1 MiB. After the source is unpacked and before the first step, the worker runs `git apply --check` and then `git apply` on the host. Patches with paths outside the tree (absolute, `..`, `.git`), symlinks or binary content are refused. A patch that is refused or does not apply fails the task with no step run; the summary is `patch does not apply: <first git error line>` or `patch refused: <reason>`. A malformed `patch` or `warm` field also fails that task only.

A task may carry `warm: { key, role }` (`key` is the repo name, `[a-z0-9-]`, up to 64 characters). The worker keeps at most one warm cargo target dir per key in `warmDir`, with a JSON record (commit, size, last use). A `build` task is a build of the repo's upstream main: it runs with an empty target dir and, when every step succeeded, replaces the warm dir for its key atomically with its target dir. A `use` task starts with a copy of the warm dir (`cp -a --reflink=auto`) or an empty target dir, and discards it afterwards, so a PR build never changes the warm dir. After each store, least recently used warm dirs are removed until the total is within `warmMaxGb`. The free-disk pause measures the smaller free space of the work dir and the warm dir.

### Crate cache

The shared crate cache (`<workDir>/crate-cache`) is never mounted into a container. Each task gets its own `CARGO_HOME`, seeded by copying `.crate` files from the shared cache and deleted with the task. Cargo does not re-verify files already in its cache, so nothing a task wrote is trusted. Right after each `fetch` step, before any build script or test has run, the worker process on the host admits a file to the shared cache only if it is a regular `.crate` in the official crates.io registry directory (`index.crates.io-*`) and its sha256 equals the checksum in the crates.io sparse index (fetched over HTTPS, looked up once per crate name). Other registries, git sources, anything written by offline steps and anything the index lookup cannot confirm are never admitted. Build output (`/target`) is shared only through the warm target dirs below.

`rustPlan()` (`src/worker/rust.ts`) returns the Rust steps: `fetch deps` (`cargo fetch --locked`, network), then `build` and `test` with `--offline --locked`. The source is read-only, so `Cargo.lock` must be committed.

### Remote hosts

A remote worker is the same program with a config whose `coordinatorUrl` points to the coordinator's worker listener (`CRAFT_AUTO_WORKER_LISTEN`, exposed over the tailnet behind TLS) and its own key. Register it as another environment; the coordinator hands tasks to whichever environment has a free slot that satisfies the task's requirements.

## Production install

A production install runs the dashboard, the runner, the sync timer and a daily database backup as system services of one unprivileged user, and deploys by `git push`. `<root>` is that user's home. Files in `deploy/`:

| File | Use |
|---|---|
| `autocraft.env.example` | The settings file, `<root>/config/autocraft.env`: every path (database, caches, secrets, accounts), the listen addresses and the public URL. |
| `systemd/autocraft-*.service`, `*.timer` | System units with `@ROOT@` and `@USER@` placeholders: dashboard, runner, sync (every minute) and backup (daily). They read the settings file. |
| `post-receive` | Bootstrap hook for `<root>/repo.git` (a bare repo). Install it once; it runs `deploy/hook.sh` from the pushed commit. |
| `hook.sh` | Snapshots the database, pauses the sync timer, builds `<root>/releases/<commit>` (dependencies, `web/dist`), updates the sandbox worker code (when `AUTOCRAFT_WORKER_SSH` is set) switches the `<root>/app` symlink and restarts the units named by `AUTOCRAFT_UNITS`. A failed deploy prints the command that redeploys the same commit. |
| `push.sh` | `deploy/push.sh REMOTE [REF]`: pushes a branch to the bare repo. |
| `backup.sh` | `backup.sh [PREFIX [KEEP]]`: consistent snapshot with `sqlite3 .backup`, compressed, newest KEEP kept. |

Layout: `<root>/{repo.git,releases,app,data,cache,config}` (`app` is a symlink to the current release). `<root>/config` holds the settings file, `secrets.json` (mode 0600), `accounts.json` and the per-account Claude config directories. The user needs `node` 24, `git`, `pnpm`, `sqlite3`, `curl`, `bwrap`, `gh` (logged in, with its git credential helper), `claude` (logged in per account) and `jev` on its PATH (`<root>/.local/bin` comes first). The restart needs a sudoers entry allowing the user `systemctl restart` of its own units, and `start`/`stop` of the sync timer, without a password. The units load `autocraft.env` themselves as the app user. The worker runs as a separate user (see Running a worker); `AUTOCRAFT_WORKER_SSH` and an SSH key at `<root>/.ssh/id_craftsandbox` let the hook install its code through the worker's forced-command key.

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

## License

AutoCraft is dual-licensed under [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE), at your option.
