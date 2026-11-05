# One image for the dashboard, the runner and the one-shot sync and backup commands.
# Build from the repository root:  docker build -f deploy/container/Dockerfile -t autocraft .
# The command picks the process: dashboard | runner | sync | backup | (any `autocraft` subcommand).
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9

FROM ${NODE_IMAGE} AS web
RUN npm install -g pnpm@11.28.10
WORKDIR /app/web
COPY web/package.json web/pnpm-lock.yaml web/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
# src/ and docs/ are read by the web build too (shared API types, About page text).
COPY src /app/src
COPY docs /app/docs
COPY web ./
RUN pnpm exec vite build --outDir dist --emptyOutDir

FROM ${NODE_IMAGE}
# Claude CLI: pinned like the host install, which updates by hand (DISABLE_AUTOUPDATER).
ARG CLAUDE_CODE_VERSION=2.1.309
RUN apt-get update \
 && apt-get install -y --no-install-recommends bubblewrap git sqlite3 curl ca-certificates tini zstd \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g pnpm@11.28.10 @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
 && npm cache clean --force

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY src ./src
COPY scripts ./scripts
COPY deploy/backup.sh deploy/container/entrypoint.sh ./deploy/
COPY web/src ./web/src
COPY --from=web /app/web/dist ./web/dist

# Every writable path is under /data (database, caches, job logs, HOME) or /config
# (secrets, accounts, Claude config directories); mount volumes there.
ENV HOME=/data/home \
    XDG_CACHE_HOME=/data/cache \
    DISABLE_AUTOUPDATER=1 \
    AUTOCRAFT_DB=/data/mirror.db \
    AUTOCRAFT_LISTEN=0.0.0.0:3005 \
    AUTOCRAFT_WORKER_LISTEN=0.0.0.0:8981 \
    AUTOCRAFT_SECRETS_FILE=/config/secrets.json \
    AUTOCRAFT_ACCOUNTS=/config/accounts.json \
    AUTOCRAFT_ACCOUNTS_ROOT=/config/claude \
    AUTOCRAFT_USAGE_DIR=/data/cache/autocraft/usage \
    AUTOCRAFT_LOCK_DIR=/data/cache/autocraft/locks \
    AUTOCRAFT_RUNNER_LOGS=/data/cache/autocraft/jobs \
    AUTOCRAFT_DIFF_CACHE=/data/cache/autocraft/diffs \
    AUTOCRAFT_CHECKOUT_DIR=/data/cache/autocraft/checkouts \
    AUTOCRAFT_FIXUP_DIR=/data/cache/autocraft/fixups \
    AUTOCRAFT_BACKUP_DIR=/data/backups

RUN chmod +x deploy/entrypoint.sh \
 && mkdir -p /data /config \
 && chown 10001:10001 /data /config
USER 10001:10001
EXPOSE 3005 8981
VOLUME ["/data", "/config"]
ENTRYPOINT ["/usr/bin/tini", "--", "/app/deploy/entrypoint.sh"]
CMD ["dashboard"]
