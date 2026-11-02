# craft-automation

Local mirror of every storytold issue and PR, the triage pipeline's state, and the backlog dashboard.

- `craft-auto sync` fills a SQLite mirror (`~/.local/share/craft-automation/mirror.db`, or `$CRAFT_AUTO_DB`) from GitHub GraphQL. Agents and scripts query the mirror instead of calling `gh`.
- `craft-auto whitelist` shows and edits which contributors' PRs may merge on green CI without a decision.
- `craft-auto dash serve` serves the dashboard.
- `craft-auto runner serve` runs pipeline steps as jobs requested on the dashboard's Pipeline page or by schedules.

Schema: `src/schema.sql`. Mirror tables are overwritten by sync; work tables (classifications, stages, whitelist overrides, token use) are ours.

TypeScript on Node 24, run directly (type stripping, no build step): `node src/cli.ts <command>`. SQLite through the built-in `node:sqlite`. `pnpm check` type-checks; `pnpm test` runs the tests.

## Dashboard server

`craft-auto dash serve` serves the dashboard over plain HTTP; a proxy in front provides HTTPS. Every page needs GitHub sign-in, and only logins on the access list get a session. Roles are `operator` (answers decisions, manages the whitelist, repos and access), `maintainer` and `viewer` (both read and give opinions). Add the first operator from a shell: `craft-auto access add <login> --operator`. Then manage the list on the Access page or with `craft-auto access list|add|remove|role`.

The frontend is the React app in `web/`. Build it before serving: `pnpm -C web install && pnpm -C web build` (writes `web/dist`). Without a build the server answers app pages with a 503 that says so. `VITE_MOCK=1 pnpm -C web build` builds a mockup on fake data that runs without the server.

| Variable | Meaning |
|---|---|
| `CRAFT_AUTO_BASE_URL` | Public origin of the dashboard, such as `https://dashboard.example.org` (no path). The OAuth App's callback URL must be exactly `<CRAFT_AUTO_BASE_URL>/auth/callback`. Required unless dev auth is on. |
| `CRAFT_AUTO_LISTEN` | `host:port` to listen on. Default `127.0.0.1:8993`. |
| `CRAFT_AUTO_DB` | SQLite database path (the mirror database). |
| `CRAFT_AUTO_WEB_DIST` | Directory of the built frontend. Default `web/dist` in the repo. |
| `CRAFT_AUTO_SECRETS_FILE` | JSON file with `github_client_id`, `github_client_secret` and `session_key` (at least 32 characters, random). Must be mode 0600; the server refuses to start if it is missing, incomplete, or readable by group or others. |
| `CRAFT_AUTO_TRUST_PROXY` | `1` to take the client address for rate limits from the last `X-Forwarded-For` entry. Set it only behind a proxy that sets that header. |
| `CRAFT_AUTO_IMG_CACHE` | Disk cache of the image proxy. Default `$XDG_CACHE_HOME/craft-automation/img` (`~/.cache/...`); empty for no disk cache. |

The GitHub OAuth App needs no scopes, and expiring user tokens are supported: the server refreshes them as needed and ends the session when a refresh fails. Tokens are stored encrypted with a key derived from `session_key`; changing `session_key` ends every session.

### Images

`GET /img?u=<url>` (signed in only) fetches GitHub-hosted images from issue and PR bodies so the app can show them inline under its CSP. It serves only `https` URLs on `github.com/user-attachments/assets/<uuid>`, `private-user-images.githubusercontent.com`, `user-images.githubusercontent.com`, `raw.githubusercontent.com/storytold/` and `avatars.githubusercontent.com`; everything else is a 404. It follows at most three redirects, each to one of those hosts or GitHub's attachment bucket (`github-production-user-asset-6210df.s3.amazonaws.com`). Requests to `github.com` carry the bot's token from `gh auth token`, run in the repo's directory and kept in memory for an hour; no other host gets it. It serves PNG, JPEG, GIF, WebP and AVIF, checked by their magic bytes, up to 15 MB, within 15 seconds; never SVG. Responses are `private, max-age=86400` with `default-src 'none'` and `nosniff`; images are cached on disk for 7 days (at most 512 MB), and each session may make 120 upstream fetches a minute.

### Development sign-in

With `CRAFT_AUTO_DEV_AUTH=1` the server uses a fake GitHub: `/auth/signin` shows a form that signs in as any login typed into it (the login must still be on the access list). It needs no secrets file and starts only on a loopback listen address. Repo permissions come from the JSON file named by `CRAFT_AUTO_DEV_PERMS`, read on every check: `{"<login>": {"<repo>": "write"}}` (values `admin`, `maintain`, `write`, `triage`, `read`). `CRAFT_AUTO_DEV_TOKEN_TTL` sets the fake access tokens' lifetime in seconds (default 8 hours). Open the dashboard as `http://localhost:<port>` so the browser accepts its `Secure` cookies.

### JSON API

The frontend in `web/` talks to `/api/`; the wire types are `web/src/api/types.ts`. Every endpoint needs a session (401 JSON without one) and returns errors as `{"error": "..."}` with a status code. Every `/api/` response carries the session's CSRF token in `X-CSRF-Token`; every POST must send it back in the same header, with a JSON body (at most 64 KB). A POST whose `Origin` or `Sec-Fetch-Site` names another site is refused.

| Method and path | Who |
|---|---|
| `GET /api/me`, `/api/repos`, `/api/progress`, `/api/search?q=`, `/api/items/<repo>/<n>` | anyone signed in |
| `GET /api/classifiers?run=&a=&b=` (agreement, confusion, confidence bands and flags for a run and classifier pair; defaults to the latest run), `/api/classifiers/disagreements?run=&a=&b=&label=&band=&limit=&offset=` | anyone signed in |
| `GET /api/cost?run=` (token use, USD where recorded, and wall time per stage and model and per repo, plus spend over time; all runs when `run` is empty) | anyone signed in |
| `GET /api/decisions?status=open\|opinions\|answered&repo=&kind=&minAge=&mine=1&limit=&offset=`, `/api/decisions/<id>`, `/api/decisions/<id>/thread` | anyone signed in; answer notes only for operators |
| `POST /api/decisions/<id>/answer` `{answer, note?, exceptions?}`, `/undo`, `/adopt` `{opinionId}` | operator with write, maintain or admin on every repo the decision covers |
| `POST /api/decisions/<id>/opinion` `{option, note?}`, `/retract`, `/comments` `{body}` | anyone signed in; audited; non-operators get 60 an hour per login |
| `POST /api/decisions/<id>/claim` | anyone signed in: marks the decision as being looked at for 10 minutes |
| `GET /api/contributors?q=&tier=&repo=&sort=&desc=&limit=&offset=` | anyone signed in; override notes only for operators |
| `GET /api/contributors/rule-preview?minMerged=&minRate=`; `POST /api/contributors/rule` `{minMerged, minRate}`, `/api/contributors/<login>/override` `{status: "allow"\|"deny"\|null, note?}` | operator |
| `GET /api/repos/all`; `POST /api/repos/track` `{name}`, `/api/repos/untrack` `{name}` | operator |
| `GET /api/access`, `/api/audit?login=&action=&limit=&offset=`; `POST /api/access/add` `{login, role, note?}`, `/api/access/remove` `{login}`, `/api/access/role` `{login, role}`, `/api/access/sessions/revoke` `{id}` | operator; the last operator can't be removed or demoted |
| `GET /api/pipeline` (stages, steps with their params schema, schedules and last job, runner heartbeat, recent syncs), `/api/pipeline/jobs?step=&state=&limit=&offset=`, `/api/pipeline/jobs/<id>` (with the scrubbed end of its log) | anyone signed in |
| `POST /api/pipeline/jobs` `{step, params}`, `/api/pipeline/jobs/<id>/cancel`, `/api/pipeline/schedules/<step>` `{enabled, trigger: "interval"\|"after-sync", intervalMinutes, params}` | operator; audited |
| `POST /api/signout` | anyone signed in |

Opinions and comments are display-only. The pipeline reads answers with `craft-auto decisions list --actionable` (one JSON object per line: option keys of unapplied answers by a current operator), which never includes them.

## Pipeline runner

`craft-auto runner serve` is the only process that runs pipeline steps (how the parts fit together: [docs/pipeline.md](docs/pipeline.md#architecture)). It polls the `jobs` table every 2 seconds, runs each job in a child process (`craft-auto runner exec <id>`) with its output in a log file, stops jobs whose cancel was requested, and queues the jobs that schedules ask for. On start it marks jobs that an earlier runner left running as failed. A lock file keeps a second runner on the same database from starting.

It reads the same variables as the CLI (`CRAFT_AUTO_DB` and the rest), plus:

| Variable | Meaning |
|---|---|
| `CRAFT_AUTO_RUNNER_LOGS` | Directory of the per-job log files. Default `~/.cache/craft-automation-logs/jobs`. The dashboard reads each job's log from the path recorded in its row, so it must run as a user who can read this directory. |
| `CRAFT_AUTO_RUNNER_JOBS` | Most jobs running at once. Default 2; jobs of one concurrency group always run one at a time. |
| `CRAFT_AUTO_RUNNER_POLL_MS` | Poll interval. Default 2000. |
| `CRAFT_AUTO_LOCK_DIR` | Directory of the lock file, shared with `sync`. Default `~/.cache/craft-automation-logs`. |
| `CRAFT_AUTO_EXTRA_STEPS` | A module exporting `steps: StepDef[]` that is added to the step list, for tests and development (`test/runner-steps.ts` has fake steps). Set it for the dashboard and the runner alike, or not at all. |

The classify steps call `jev` and `claude`, so the runner's `PATH` must reach them.

To run it as a systemd user service, fill in the placeholders of `deploy/craft-runner.service`, copy it to `~/.config/systemd/user/`, and run `systemctl --user daemon-reload && systemctl --user enable --now craft-runner`. Stopping the service stops running jobs; they show as failed and can be started again.

From a shell: `craft-auto runner steps` lists steps and their params, `runner enqueue <step> [--<param> <value> ...]` queues a job (recorded as `cli`), `runner jobs [--state S]` lists jobs, `runner cancel <id>` cancels one.

### Adding a step

A step is one entry in `STEPS` in `src/runner/steps.ts`:

```ts
{
  name: "review-batch",
  title: "Review PRs",
  description: "Sonnet reviews the open PRs of one repo that are marked for review.",
  stage: 5,                      // docs/pipeline.md stage
  requires: "operator",
  group: "models",               // one job of a group at a time
  params: [
    { name: "repo", label: "Repo", kind: "repo", required: true },
    { name: "limit", label: "At most", kind: "int", min: 1, max: 50, default: 10 },
  ],
  run: async (ctx) => (await import("../review/step.ts")).reviewBatch(ctx),
}
```

Param kinds are `enum`, `repo` (a tracked repo), `int` and `run-id`; there is no free-text kind, so nothing typed on the dashboard reaches a prompt. `run` gets the database, the validated params, `progress(text)`, `log(line)`, `usageRun(runId)` (token use recorded under that run from the job's start counts as the job's) and `cancelled()`, and returns a one-line summary; throwing fails the job with the error's message. `available()` and `check(db, params)` can refuse a step or a request with a reason. The Pipeline page, the API, schedules and the CLI pick the step up from the list.
