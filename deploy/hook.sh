#!/bin/bash
# The deploy of a production install, run by deploy/post-receive as the app user
# with cwd = the bare repo and GIT_DIR set. Layout under the install root
# (default: the parent of the bare repo):
#
#   repo.git/  releases/<commit>/  app -> releases/<commit>  data/  cache/  config/autocraft.env
#
# Every path and name comes from config/autocraft.env (see the README section
# "Production install") or from the variables below.
#
#   AUTOCRAFT_ROOT             install root (default: parent of the bare repo)
#   AUTOCRAFT_ENV_FILE         default $AUTOCRAFT_ROOT/config/autocraft.env
#   AUTOCRAFT_BRANCH           branch that deploys (default main)
#   AUTOCRAFT_UNITS            systemd units restarted after the build
#                              (default "autocraft-dashboard autocraft-runner"; empty for none).
#                              Not restarted while the database file does not exist yet.
#   AUTOCRAFT_SUDO             command prefix for the restart (default "sudo -n")
#   AUTOCRAFT_WORKER_SSH       user@host of the sandbox worker's admin SSH command; when set
#                              and $AUTOCRAFT_ROOT/.ssh/id_craftsandbox exists, the worker code
#                              is updated to this commit (restarts the worker)
#   AUTOCRAFT_HEALTH_URL       URL polled after the restart (default: http://$CRAFT_AUTO_LISTEN/)
#
# Order: snapshot the database, stop the sync timer, build the new release beside
# the running one, switch the `app` symlink, restart, start the timer. A failure
# before the switch leaves the previous release running on an unmigrated database.
# After a failed deploy, pushing again does nothing (the branch already moved);
# redeploy by running the bare repo's hook by hand (printed on failure).
#
#   AUTOCRAFT_TIMER            sync timer paused during the deploy (default autocraft-sync.timer)
#   AUTOCRAFT_KEEP_RELEASES    releases kept besides the current one (default 2)
set -euo pipefail

GIT_DIR="$(cd "${GIT_DIR:-.}" && pwd)"
export GIT_DIR
ROOT="${AUTOCRAFT_ROOT:-$(dirname "$GIT_DIR")}"
BRANCH="${AUTOCRAFT_BRANCH:-main}"
ENV_FILE="${AUTOCRAFT_ENV_FILE:-$ROOT/config/autocraft.env}"
SUDO="${AUTOCRAFT_SUDO:-sudo -n}"
TIMER="${AUTOCRAFT_TIMER-autocraft-sync.timer}"
SYNC_UNIT="${TIMER%.timer}.service"

export HOME="${HOME:-$ROOT}"
export PATH="$ROOT/.local/bin:/usr/local/bin:/usr/bin:/bin"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
if [ -r "$ENV_FILE" ]; then
	set -a
	# shellcheck disable=SC1090
	. "$ENV_FILE"
	set +a
else
	echo "!! $ENV_FILE is missing; create it first (README, Production install)" >&2
	exit 1
fi

timer_stopped=0
on_exit() {
	rc=$?
	if [ "$timer_stopped" = 1 ]; then $SUDO systemctl start "$TIMER" || true; fi
	if [ "$rc" -ne 0 ]; then
		echo "!! deploy failed. After fixing the cause, redeploy this commit by running, as this user:" >&2
		echo "   cd $GIT_DIR && echo \"0 \$(git rev-parse $BRANCH) refs/heads/$BRANCH\" | GIT_DIR=. hooks/post-receive" >&2
	fi
}
trap on_exit EXIT

exec {lockfd}>"$ROOT/.deploy.lock"
if ! flock -n "$lockfd"; then
	echo "!! another deploy is running; wait for it, then redeploy" >&2
	exit 1
fi

sha="$(git rev-parse "refs/heads/$BRANCH")"
REL="$ROOT/releases/$sha"
echo "-- Deploying ${sha:0:12} to $REL --"

# Snapshot first: nothing of the new code has touched the database yet.
if [ -n "${CRAFT_AUTO_DB:-}" ] && [ -f "$CRAFT_AUTO_DB" ]; then
	echo "-> Snapshotting the database..."
	bash "$ROOT/app/deploy/backup.sh" predeploy 3 2>/dev/null || {
		# First deploy of this layout has no app/ yet: use the checkout about to be built.
		snapshot_pending=1
	}
fi

if [ -n "$TIMER" ]; then
	$SUDO systemctl stop "$TIMER"
	timer_stopped=1
	for _ in $(seq 1 150); do
		systemctl is-active --quiet "$SYNC_UNIT" || break
		sleep 2
	done
fi

echo "-> Checking out..."
rm -rf "$REL"
mkdir -p "$REL"
git --work-tree="$REL" checkout -f "$BRANCH"
printf '%s\n' "$sha" >"$REL/.source-commit"
cd "$REL"

if [ "${snapshot_pending:-0}" = 1 ]; then
	echo "-> Snapshotting the database..."
	bash "$REL/deploy/backup.sh" predeploy 3
fi

echo "-> Installing dependencies..."
pnpm install --frozen-lockfile --prod

echo "-> Building the web app..."
pnpm -C web install --frozen-lockfile
pnpm -C web exec tsc --noEmit
pnpm -C web exec vite build --outDir dist --emptyOutDir

echo "-> Checking that the CLI loads..."
usage="$(node --no-warnings src/cli.ts)"
for c in dash runner sync; do
	printf '%s\n' "$usage" | grep -Eq "^ +$c " || { echo "!! the CLI does not list '$c'; a module failed to load" >&2; exit 1; }
done

if [ -n "${AUTOCRAFT_WORKER_SSH:-}" ] && [ -f "$ROOT/.ssh/id_craftsandbox" ]; then
	ssh_worker=(ssh -i "$ROOT/.ssh/id_craftsandbox" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new "$AUTOCRAFT_WORKER_SSH")
	if [ "$("${ssh_worker[@]}" version 2>/dev/null || true)" != "$sha" ]; then
		echo "-> Updating the sandbox worker code..."
		git archive "$BRANCH" | "${ssh_worker[@]}" update "$sha"
	else
		echo "-> Sandbox worker code is current."
	fi
fi

echo "-> Switching app to ${sha:0:12}..."
ln -sfn "releases/$sha" "$ROOT/app.new"
mv -T "$ROOT/app.new" "$ROOT/app"

units="${AUTOCRAFT_UNITS-autocraft-dashboard autocraft-runner}"
if [ -n "$units" ] && [ -n "${CRAFT_AUTO_DB:-}" ] && [ ! -f "$CRAFT_AUTO_DB" ]; then
	echo "-> No database at $CRAFT_AUTO_DB yet; built, not restarting."
	units=""
fi
if [ -n "$units" ]; then
	echo "-> Restarting: $units"
	# shellcheck disable=SC2086
	for u in $units; do $SUDO systemctl restart "$u.service"; done
	url="${AUTOCRAFT_HEALTH_URL:-http://${CRAFT_AUTO_LISTEN:-127.0.0.1:8993}/}"
	up=0
	for _ in $(seq 1 30); do
		if curl -s -o /dev/null --max-time 2 "$url"; then up=1; break; fi
		sleep 1
	done
	[ "$up" = 1 ] || { echo "!! no answer from $url after the restart; see journalctl -u ${units%% *}" >&2; exit 1; }
	sleep 3
	for u in $units; do
		systemctl is-active --quiet "$u.service" || { echo "!! $u is not active after the restart; see journalctl -u $u" >&2; exit 1; }
	done
	echo "-> Up: $url"
fi

# Keep the current release and the newest few others.
keep="${AUTOCRAFT_KEEP_RELEASES:-2}"
ls -1t "$ROOT/releases" | grep -vx "$sha" | tail -n +$((keep + 1)) | while read -r old; do rm -rf "$ROOT/releases/$old"; done
