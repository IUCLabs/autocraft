# Moving a systemd install to a container

This runbook moves a running systemd install (see Production install in [operations.md](operations.md)) to the container image (see Running in a container). It was rehearsed with rootless Docker on a copy of a production database, with the network disabled and the pipeline off.

Placeholders: `<root>` is the systemd install root, `IMAGE` the image, `DATA` and `CONFIG` the volumes mounted at `/data` and `/config`. The `docker run` lines show the shared options as `$RUN`:

```
RUN="-v DATA:/data -v CONFIG:/config --env-file container.env"
```

`container.env` holds `AUTOCRAFT_BASE_URL`, `AUTOCRAFT_TRUST_PROXY` and any other setting from the systemd settings file that is not a path. Do not copy the path settings (`AUTOCRAFT_DB`, `AUTOCRAFT_SECRETS_FILE`, cache and lock directories, listen addresses): the image sets them.

Steps marked **admin** need a person with access to the secrets or to DNS and the proxy.

## Before the window

1. **admin**: Build or pull the image and start it once with `--network none` against an empty volume to check that it runs (`IMAGE pipeline status`).
2. **admin**: Decide where the dashboard is reachable and keep the DNS and reverse-proxy change ready. `AUTOCRAFT_BASE_URL` must be the public origin; the GitHub App's callback and setup URLs and the OAuth app's callback URL must match it (see Moving to a new domain in [deploy-checklist.md](deploy-checklist.md)).
3. Check the free space of the target volume: the database plus its newest backup (a 1.2 GB database restored in under 10 s).

## Cut-over

1. **Pipeline off.** On the old host: `autocraft pipeline off`. Wait until the runner has no running job (`autocraft pipeline status`, or the jobs list on the dashboard). `pipeline off` holds only automatic jobs: jobs queued by a user or the CLI stay queued and would start on the new runner. List them with `autocraft runner jobs --state queued` and cancel each with `autocraft runner cancel <id>`. Check that the list is empty before the final backup.
2. **Final backup.** `deploy/backup.sh predeploy` (with the systemd settings loaded). It writes `<database dir>/backups/predeploy-<UTC time>.db.zst` from a consistent snapshot and checks its integrity. Keep the file name.
3. **Stop the old services**: the runner, the dashboard, the sync and backup timers. Nothing may write to the old database from now on. Do not delete anything on the old host.
4. **Create the volumes** and make `/data` and `/config` writable by uid 10001. With Docker, named volumes take that ownership from the image. In Kubernetes, `fsGroup: 10001` does it.
5. **Restore the database** into the data volume. Stream the backup through a container so no host permissions are involved (the volume belongs to uid 10001, and under rootless Docker the host cannot read it):

   ```
   zstd -dc predeploy-<time>.db.zst | docker run -i --rm -v DATA:/data --entrypoint sh IMAGE -c 'rm -f /data/mirror.db-wal /data/mirror.db-shm; cat > /data/mirror.db'
   docker run --rm -v DATA:/data --entrypoint sqlite3 IMAGE /data/mirror.db 'PRAGMA quick_check'
   ```

   Expect `ok`. Restore only the `.db` file; never copy `-wal` or `-shm` files from the old host. On a volume that held a database before, the restore command deletes stale `-wal` and `-shm` files first.
6. **Place the secrets. admin.** Create `/config/secrets.json` with mode 0600, owner uid 10001, with the old file's content. Keep `session_key` byte for byte: the dashboard seals each user's GitHub tokens with it, and with a different key every sealed token reads as unavailable until the user signs in again. The GitHub client and App keys come from the same file. Never put the file in an image, a manifest or a log.

   ```
   docker run -i --rm -v CONFIG:/config --entrypoint sh IMAGE -c 'umask 077; cat > /config/secrets.json' < secrets.json
   ```

   The dashboard refuses to start if the file is readable by group or others.
7. **Place the accounts. admin.** Copy `accounts.json` and the Claude configuration directories (`<root>/config/claude/`, one per account, with their logins) to `/config/accounts.json` and `/config/claude/`, owned by uid 10001, keeping the modes (credentials are 0600). The systemd install used a logged-in `gh`; the container uses a token instead. The admin creates a GitHub token for `gh` (classic personal access token with the `repo`, `read:org` and `workflow` scopes; keep `workflow`, which lets the pipeline push to branches that change workflow files) and sets it as `GH_TOKEN` for the dashboard, the runner and the sync and backup containers (with Docker, `GH_TOKEN=...` in a `container.env` file of mode 0600 passed with `--env-file`; in Kubernetes, the Secret `autocraft-github`). The dashboard needs it for the image proxy and for adding a repository. If a login does not carry over, sign in again with the account's Claude CLI inside the container.
8. **Start the dashboard**, then the runner (the runner needs the sandbox options from Sandbox (bubblewrap) in operations.md). Both start with the pipeline off, because the restored database says so:

   ```
   docker run -d --name autocraft-dashboard $RUN -p 3005:3005 IMAGE dashboard
   docker run -d --name autocraft-runner $RUN --stop-timeout 30 \
     --security-opt seccomp=unconfined --security-opt systempaths=unconfined IMAGE runner
   ```

   Start the sync and backup schedules last (`IMAGE sync` every minute, `IMAGE backup daily 7` daily, or the `periodic` container of the Kubernetes manifest).
9. **Check**, with the pipeline still off:
   - `GET /healthz` and `/readyz` answer 200 on the dashboard (3005) and on the runner's worker API (8981).
   - The logs show `dashboard listening` and `runner: started on N steps`.
   - `IMAGE repos list` shows the same repositories with the same open and mirrored counts as on the old host (the old host's last sync time can differ by up to a minute).
   - `IMAGE pipeline status` prints `pipeline OFF`.
   - The runner started no job: the highest job id does not change.
   - **admin**: open the Accounts page after signing in. Each account shows its state and usage.
10. **Switch the traffic. admin.** Point DNS or the proxy at the new dashboard. If the origin changed, update the GitHub App's callback and setup URLs and the OAuth app's callback URL (Moving to a new domain in [deploy-checklist.md](deploy-checklist.md)). Point the workers at the new runner's worker API (see Running a worker); keep that port off the public network.
11. **Pipeline on.** `docker exec autocraft-runner node --no-warnings src/cli.ts pipeline on`, or `docker run --rm $RUN IMAGE pipeline on` (the database is shared through the volume). Watch the first jobs finish on the dashboard.

## Rollback

Do this if a check in step 9 or the first jobs after step 11 fail.

1. Pipeline off on the new instance, then stop and keep (do not remove) its containers and volumes: the new instance stays off from now on, so only one runner ever writes a database.
2. Point DNS and the proxy back, and revert the OAuth app's callback URL and, if you changed them, the GitHub App's callback and setup URLs to the old origin.
3. Start the old services on the old database: the dashboard, then the runner, then the timers. The old database is the state of step 2; the new instance's changes since then are not carried back. If the pipeline made changes on GitHub in between, the next sync reads them.
4. `autocraft pipeline on` on the old host when the checks pass there.

A second attempt starts from the cut-over again with a fresh final backup (the old host's pipeline off, the new volumes emptied).

## Rehearsal results

Rehearsed with rootless Docker on a copy of the newest production snapshot (1.2 GB database, 500 MB compressed), `--network none`, a placeholder `secrets.json` with a generated `session_key` and no Claude or GitHub logins.

| Step | Result |
|---|---|
| Decompress and restore into the volume | 8.8 s |
| Integrity check of the restored file | `ok`, journal mode `wal` |
| Dashboard start to `/readyz` 200 | 1.5 s |
| Runner start to `/readyz` 200 | 1.0 s |
| `repos list` | all repositories, counts equal to the snapshot |
| `pipeline status` | `OFF` |
| Runner with the pipeline off | planner passes of 3 to 7 s run continuously (about 2 CPU cores on this database), no job is queued or started |
| `backup predeploy` in the container | 12.7 s, snapshot written to `/data/backups` |
| Runner stop (SIGTERM) | does not finish within `AUTOCRAFT_STOP_TIMEOUT` (25 s): the planner's worker thread keeps running at 100% CPU, the runner logs `stop timed out; exiting` and the process ends only after 80 to 140 s, or when the orchestrator kills it (exit 137 at the stop timeout). The next start worked every time (stale lock recognised, no recovery needed with no job running). The dashboard stops in under 0.1 s. |
| Sealed GitHub tokens read with another `session_key` | `null` (unavailable), no error |

Open problem: the runner stop above also happens on any host with a database this size; stop the runner during the cut-over and the rollback with `docker stop --time 30` and accept the kill. The database is in WAL mode and survives it.

Not covered: the Accounts page (it needs a signed-in session and the GitHub App), Claude and GitHub calls, and a runner with a running job.

## Kubernetes variant

A StatefulSet pod holds the ReadWriteOnce claims, so nothing else can mount them while it runs. Place the data and secrets before the first start:

1. Set `replicas: 0` in `deploy/k8s/autocraft.yaml` and apply it. The claims `data-autocraft-0` and `config-autocraft-0` exist and no pod runs.
2. Start a helper pod that mounts both claims (uid 10001, `fsGroup` 10001, the same image, `command: [sleep, 3600]`). Do cut-over steps 5 to 7 in it with `kubectl exec -i` and `kubectl cp`: restore the database (including the deletion of stale `-wal` and `-shm` files), then place `secrets.json` (mode 0600), `accounts.json` and the Claude directories.
3. Delete the helper pod and wait until it is gone.
4. Create the Secret `autocraft-github` (key `token`), then scale up: `kubectl scale statefulset autocraft --replicas=1`.
