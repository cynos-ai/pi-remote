ARG DOCKER_REGISTRY_MIRROR=docker.m.daocloud.io
ARG NODE_IMAGE_TAG=24.19.0-bookworm-slim
ARG DEBIAN_MIRROR=https://mirrors.aliyun.com

FROM ${DOCKER_REGISTRY_MIRROR}/library/node:${NODE_IMAGE_TAG} AS build

ARG NPM_REGISTRY=https://registry.npmmirror.com
ENV NPM_CONFIG_REGISTRY=${NPM_REGISTRY}
ENV npm_config_registry=${NPM_REGISTRY}
WORKDIR /workspace

# Keep the package manager and registry explicit in the image build. The
# workspace .npmrc is copied below as an additional, reviewable safeguard.
RUN npm install --global pnpm@10.28.0 --registry=${NPM_REGISTRY}

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/server/package.json apps/server/package.json
COPY packages/agent-pi/package.json packages/agent-pi/package.json
COPY packages/protocol/package.json packages/protocol/package.json
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build:server
RUN mkdir -p /runtime/apps/server /runtime/packages/agent-pi /runtime/packages/protocol \
  && cp -a apps/server/node_modules /runtime/apps/server/ \
  && cp -a packages/agent-pi/node_modules /runtime/packages/agent-pi/ \
  && cp -a packages/protocol/node_modules /runtime/packages/protocol/
# pnpm refuses to remove the existing workspace modules directory without a
# TTY unless CI is explicit. Docker builds are non-interactive by design.
RUN CI=true pnpm prune --prod

FROM ${DOCKER_REGISTRY_MIRROR}/library/node:${NODE_IMAGE_TAG} AS runtime

ARG DEBIAN_MIRROR=https://mirrors.aliyun.com

ENV NODE_ENV=production \
    PI_REMOTE_HOST=0.0.0.0 \
    PI_REMOTE_PORT=8080 \
    PI_REMOTE_STATE_DIR=/state \
    PI_REMOTE_PI_DIR=/state/pi \
    PI_REMOTE_WORKSPACE_ROOT=/workspaces \
    PI_REMOTE_DATABASE_FILE=/state/state.sqlite \
    HOME=/state/home \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# Keep Debian package downloads on the deployment's domestic mirror by
# default. The argument remains overridable for an operator with a local
# mirror or an environment that requires the upstream repository.
RUN sed -i \
  -e "s|https\?://deb.debian.org/debian-security|${DEBIAN_MIRROR}/debian-security|g" \
  -e "s|https\?://deb.debian.org/debian|${DEBIAN_MIRROR}/debian|g" \
  /etc/apt/sources.list.d/debian.sources

# These are the tools the native pi executor expects in a normal Linux
# development environment. sqlite3 is diagnostic only; the service uses
# node:sqlite for application storage.
# The slim base has no CA bundle yet. The two apt options are limited to this
# bootstrap transaction; ca-certificates is installed before the layer ends.
RUN apt-get \
    -o Acquire::https::Verify-Peer=false \
    -o Acquire::https::Verify-Host=false \
    update \
  && apt-get \
    -o Acquire::https::Verify-Peer=false \
    -o Acquire::https::Verify-Host=false \
    install --no-install-recommends -y \
    bash \
    ca-certificates \
    git \
    openssh-client \
    python3 \
    sqlite3 \
    tini \
    util-linux \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /workspace/node_modules ./node_modules
COPY --from=build /runtime/apps/server/node_modules ./apps/server/node_modules
COPY --from=build /workspace/apps/server/package.json ./apps/server/package.json
COPY --from=build /workspace/apps/server/dist ./apps/server/dist
COPY --from=build /runtime/packages/agent-pi/node_modules ./packages/agent-pi/node_modules
COPY --from=build /workspace/packages/agent-pi/package.json ./packages/agent-pi/package.json
COPY --from=build /workspace/packages/agent-pi/dist ./packages/agent-pi/dist
COPY --from=build /runtime/packages/protocol/node_modules ./packages/protocol/node_modules
COPY --from=build /workspace/packages/protocol/package.json ./packages/protocol/package.json
COPY --from=build /workspace/packages/protocol/dist ./packages/protocol/dist
COPY deploy/entrypoint.sh /usr/local/bin/pi-remote-entrypoint

# Named volumes are populated from these image directories on first use. A
# bind-mounted workspace is intentionally not chowned by the image.
RUN mkdir -p /state/pi /state/outputs /state/runtime /state/worker-spool /state/home /workspaces \
  && chown -R node:node /app /state /workspaces \
  && chmod 0700 /state /state/pi /state/outputs /state/runtime /state/worker-spool /state/home \
  && chmod 0755 /workspaces \
  && chmod 0755 /usr/local/bin/pi-remote-entrypoint

USER node
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/pi-remote-entrypoint"]
CMD ["sh", "-c", "node apps/server/dist/cli.js init && exec node apps/server/dist/index.js"]
