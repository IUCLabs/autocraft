#!/bin/bash
# The deploy of a production install, run by deploy/post-receive as the app user
# with cwd = the bare repo and GIT_DIR set. Layout under the install root
# (default: the parent of the bare repo):
#
#   repo.git/  app/  data/  cache/  config/autocraft.env
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
# Order: build everything, snapshot the database, then restart. A failure before the
# restart leaves the previous build running.
set -euo pipefail

GIT_DIR="$(cd "${GIT_DIR:-.}" && pwd)"
export GIT_DIR
ROOT="${AUTOCRAFT_ROOT:-$(dirname "$GIT_DIR")}"
APP="$ROOT/app"
BRANCH="${AUTOCRAFT_BRANCH:-main}"
ENV_FILE="${AUTOCRAFT_ENV_FILE:-$ROOT/config/autocraft.env}"

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

exec {lockfd}>"$ROOT/.deploy.lock"
if ! flock -n "$lockfd"; then
	echo "!! another deploy is running; wait for it, then push again" >&2
	exit 1
fi

sha="$(git rev-parse "refs/heads/$BRANCH")"
echo "-- Deploying ${sha:0:12} to $APP --"

mkdir -p "$APP"
git --work-tree="$APP" checkout -f "$BRANCH"
cd "$APP"
printf '%s\n' "$sha" >.source-commit

echo "-> Installing dependencies..."
pnpm install --frozen-lockfile --prod

echo "-> Building the web app..."
pnpm -C web install --frozen-lockfile
pnpm -C web exec tsc --noEmit
rm -rf web/dist.new
pnpm -C web exec vite build --outDir dist.new --emptyOutDir
rm -rf web/dist.old
[ ! -d web/dist ] || mv web/dist web/dist.old
mv web/dist.new web/dist
rm -rf web/dist.old

echo "-> Checking that the CLI loads..."
node --no-warnings src/cli.ts >/dev/null

if [ -n "${CRAFT_AUTO_DB:-}" ] && [ -f "$CRAFT_AUTO_DB" ]; then
	echo "-> Snapshotting the database..."
	bash "$APP/deploy/backup.sh" predeploy 3
fi

if [ -n "${AUTOCRAFT_WORKER_SSH:-}" ] && [ -f "$ROOT/.ssh/id_craftsandbox" ]; then
	ssh_worker=(ssh -i "$ROOT/.ssh/id_craftsandbox" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new "$AUTOCRAFT_WORKER_SSH")
	if [ "$("${ssh_worker[@]}" version 2>/dev/null || true)" != "$sha" ]; then
		echo "-> Updating the sandbox worker code..."
		git archive "$BRANCH" | "${ssh_worker[@]}" update "$sha"
	else
		echo "-> Sandbox worker code is current."
	fi
fi

units="${AUTOCRAFT_UNITS-autocraft-dashboard autocraft-runner}"
if [ -n "$units" ] && [ -n "${CRAFT_AUTO_DB:-}" ] && [ ! -f "$CRAFT_AUTO_DB" ]; then
	echo "-> No database at $CRAFT_AUTO_DB yet; built, not restarting."
	units=""
fi
if [ -n "$units" ]; then
	echo "-> Restarting: $units"
	# shellcheck disable=SC2086
	for u in $units; do ${AUTOCRAFT_SUDO:-sudo -n} systemctl restart "$u.service"; done
	url="${AUTOCRAFT_HEALTH_URL:-http://${CRAFT_AUTO_LISTEN:-127.0.0.1:8993}/}"
	for _ in $(seq 1 30); do
		if curl -s -o /dev/null --max-time 2 "$url"; then echo "-> Up: $url"; exit 0; fi
		sleep 1
	done
	echo "!! no answer from $url after the restart; see journalctl -u ${units%% *}" >&2
	exit 1
fi
