# syntax=docker/dockerfile:1

# Hardened, distroless image for the HTTP transport only: docs/http-deployment.md
# (Container). Both stages track one Docker Hardened Images tag; only the
# runtime is pinned by digest. The build stage, never shipped, takes the newest
# rebuild of its tag at each build, so DHI's near-daily -dev rebuilds open no
# PR. Renovate moves the tag of both together, and release.yml republishes the
# image when only these lines change. The tag names the full Node and Alpine versions;
# a PR that moves them gets a Docker Scout comparison (base-image.yml).

FROM dhi.io/node:24.22.3-alpine3.24-dev AS build
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
# The runtime has no package manager, so everything happens here. pnpm at the
# version package.json pins; scripts stay off (`prepare` would build too early).
RUN npm install --global "pnpm@$(node -p "require('./package.json').packageManager.split('@')[1].split('+')[0]")" \
 && pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig.json tsdown.config.ts ./
COPY scripts/bundle-manifest.mjs ./scripts/
COPY src ./src
RUN pnpm build && mkdir /data

FROM dhi.io/node:24.22.3-alpine3.24@sha256:4544851709621aa77a18134101ef4cd6af39233cf57bdfe2adcc17e2e72866db
ARG VERSION=0.0.0
# The FROM above, passed in by the publish action: release.yml compares it with
# the Dockerfile's to know when the published image is on a stale base.
ARG BASE_NAME=
ARG BASE_DIGEST=
LABEL org.opencontainers.image.title="zendesk-mcp-server" \
      org.opencontainers.image.description="Zendesk MCP server, HTTP transport (OAuth 2.1 authorization server included)." \
      org.opencontainers.image.vendor="Fruggr" \
      org.opencontainers.image.source="https://github.com/fruggr/zendesk-mcp-server" \
      org.opencontainers.image.documentation="https://github.com/fruggr/zendesk-mcp-server/blob/main/docs/http-deployment.md#container" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.base.name="${BASE_NAME}" \
      org.opencontainers.image.base.digest="${BASE_DIGEST}"
WORKDIR /app
# package.json is read at runtime for the server's name and version.
COPY --from=build /src/package.json ./
COPY --from=build /src/dist ./dist
COPY --from=build --chown=1000:1000 /data /data
ENV NODE_ENV=production \
    TRANSPORT=http \
    OAUTH_STORE=file:///data/oauth-store.json \
    CUSTOMIZATION_STORE=file:///data/customizations
USER 1000:1000
EXPOSE 3000
VOLUME ["/data"]
ENTRYPOINT ["node", "/app/dist/index.js"]
