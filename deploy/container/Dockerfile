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

# GitHub CLI (sync and the pipeline's GitHub calls use it; authenticate with GH_TOKEN), pinned by checksum.
ARG TARGETARCH
ARG GH_VERSION=2.100.0
ARG GH_SHA256_AMD64=e4d4bb4498e8d007abe545b6568926793ace1b6447da598294a610018cb164be
ARG GH_SHA256_ARM64=ea4e7a581a32ccad6cc7923cb1576ac5859ba4b9a16ab22eb8f8a96e78e2e961
RUN --mount=type=tmpfs,target=/tmp \
    arch="${TARGETARCH:-amd64}" \
 && if [ "$arch" = arm64 ]; then sum="$GH_SHA256_ARM64"; else sum="$GH_SHA256_AMD64"; fi \
 && curl -fsSL -o /tmp/gh.tgz "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${arch}.tar.gz" \
 && echo "$sum  /tmp/gh.tgz" | sha256sum -c - \
 && tar -xzf /tmp/gh.tgz -C /usr/local --strip-components=1 --wildcards '*/bin/gh'

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY src ./src
COPY scripts ./scripts
COPY deploy/backup.sh deploy/container/entrypoint.sh ./deploy/
COPY web/src ./web/src
COPY --from=web /app/web/dist ./web/dist
# Shown on the dashboard's prompts page (src/dash/api/prompts.ts); there is no .git in the image.
ARG SOURCE_COMMIT=
RUN if [ -n "$SOURCE_COMMIT" ]; then printf '%s\n' "$SOURCE_COMMIT" > .source-commit; fi

# Every writable path is under /data (database, caches, job logs, HOME) or /config
# (secrets, accounts, Claude config directories); mount volumes there.
ENV HOME=/data/home \
    XDG_CACHE_HOME=/data/cache \
    DISABLE_AUTOUPDATER=1 \
    AUTOCRAFT_CLAUDE_BIN=/usr/local/bin/claude \
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
