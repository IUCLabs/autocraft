# User-local load rig

Runs user-local helpers against a scratch dashboard with injected faults and load, and prints pass or fail per acceptance line of the robustness plan (section 4). It needs no external service and makes no Claude call.

## Run

```sh
node scripts/loadtest/run.mjs smoke                 # 2 helpers, 20 calls, faults on; about 1 minute
node scripts/loadtest/run.mjs 1                     # one scenario: 1 to 6
node scripts/loadtest/run.mjs all                   # 1-5 side by side, then 6 alone; about 4 minutes at the default time scale
```

Options: `--dir <work dir>` (default a new directory under the system temp dir; mode 0700), `--db <path>` (copy of a production-like database, taken with `VACUUM INTO`; the source is opened read-only), `--time-scale S` (0.01 to 1, default 0.1, see below), `--time-factor F` (multiplies the fake harness delays, on top of the scale), `--users N`, `--parallel K`, `--calls M`, `--max-minutes N`, `--sequential` (with `all`). Exit code 1 when a line fails.

Requirements: Node 24, `bwrap` (the helper's own sandbox check), and the repository's dependencies. Run it from the repository root.

## Parts

| File | Role |
|---|---|
| `proxy.mjs` | Fault-injection HTTP proxy between helpers and dashboard. Rates of 502, connection reset, 429 with `Retry-After`, added latency, and a "down" switch that closes the listener. Faults are "before" (the dashboard never sees the request) or "after" (the dashboard acted, the helper never learns). Runtime control on a second port: `GET /state`, `POST /set {rate502, rateReset, rate429, retryAfter, latMin, latMax, afterShare}`, `POST /down?s=N`, `POST /up`. Logs one JSON line per request with the dashboard's own time (`upMs`). Also runs standalone. |
| `fake-harness.mjs` | The `claude` stand-in. Reads a `RIG {nonce, delayMs, ledger}` line from the prompt, reports `start` and `answered` per nonce to the rig's ledger, sleeps, answers in stream-json. The helper bind-mounts it into its sandbox. |
| `preload.mjs` | Loaded into each helper (`NODE_OPTIONS=--import`). Answers the plan-usage endpoint locally and blocks every other non-loopback request. |
| `rig.mjs` | The instance: scratch dashboard (`AUTOCRAFT_DEV_AUTH=1`, own database and home), users and agent tokens that can run tasks, helpers (`worker/autocraft-task.mjs work --parallel K`, each in its own process group, own config and cache), the ledger, and the call driver. |
| `report.mjs` | Collects the numbers and evaluates the acceptance lines. |
| `run.mjs` | Scenarios and the command line. |

## How it models production

- The driver is the job process: it queues calls with `enqueueCall` (so the queue class, order and columns are the real ones) and, every 3 seconds, does what a polling caller does (`seen_at` for open calls, `expireLeases`). It queues a follow-up turn for finished Opus calls that kept their session.
- Write permission comes from `repo_permissions` rows the rig refreshes every 15 seconds: helpers claim without a dashboard session, as the plan's permission track intends.
- Call mix: Opus-like `review.opus` and `premerge.opus` (60-300 s and 60-200 s), Sonnet-like `referee.sonnet` (20-90 s), Haiku-like classify, priority and dupes calls (5-20 s), and lint-like `lint.reference.haiku` calls (2-8 s). All delays are multiplied by the time factor. The time scale (`AUTOCRAFT_REMOTE_TIME_SCALE`, test only, see docs/operations.md) compresses the lease and heartbeat windows, the helpers' timings and the rig's own timings (driver ticks, permission refresh, fault times, the outage and freeze lengths, the idle-helper threshold); the fake harness delays are multiplied by it as well. The gating wait limit scales too (60 s times the scale, at least 5 s). The dashboard and every helper get the variable in their environment, and the driver sets it for itself. Dashboard latency limits are not scaled, so a scaled run loads the dashboard harder than production does. Durations in the report are real seconds; the scenario lines name the scale. Scenario tables below give production-scale times; `--time-scale 1` runs them as written (about 25 minutes for `all`).
- Lint calls and follow-up turns count as gating calls.

## Scenarios and acceptance lines

| # | Scenario | Lines checked |
|---|---|---|
| 1 | 10% 502, 5% resets, 2% 429 (`Retry-After` 2 s), 0-3 s latency | no finished reply lost |
| 2 | Dashboard restarted mid-call, then stopped for 5 minutes | no reply lost; no cool-off |
| 3 | One helper (with its harnesses) frozen with SIGSTOP for 3 minutes, then resumed | no reply lost; no call answered twice |
| 4 | One helper killed with SIGKILL mid-call, restarted 20 s later | no reply lost |
| 5 | One helper whose harness always fails | only that helper cooled off; the others finish every call |
| 6 | 50 helpers x 4 slots against 500 mixed calls, real durations | dashboard p99 under 200 ms, no request over 5 s, no SQLite busy lines, gating p95 wait under 60 s |

Every scenario also checks that no helper sat idle for over 90 seconds with calls queued without a reason visible to the user (a cool-off, a readiness other than `ready`, a last error, or a helper that is not running).

Definitions: a lost reply is a call the fake harness answered (ledger) whose call row did not end `done`. Duplicate runs are calls with more than one harness start. Latency is the dashboard's time per request as the proxy sees it, excluding injected delay and faults. SQLite busy errors are lines in the dashboard log matching `SQLITE_BUSY` or `database is locked`. Queue wait is the call's `queued_ms`.

## Output

The report prints at the end; each scenario directory also holds `report.json`, `proxy.jsonl`, `dashboard.log`, and `helpers/hN/helper.log`.

## Known limits

- A scaled run multiplies the helpers' claim rate by 1 / scale, so scenario 6 at the default scale 0.1 loads the dashboard about ten times harder than production does; its p99 line can fail there while passing at `--time-scale 1`.

- The "idle helper has a reason" line reads the helper status table. Until the Connect page shows slots, busy and last error, a helper that is ready and silent counts as idle without a reason.
- The rig does not measure the fast lane or the per-user call limit; it runs ordinary helpers, so those arrive as the helper and server tracks land.
