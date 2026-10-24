# syntax=docker/dockerfile:1

# Hardened, distroless image for the HTTP transport only: docs/http-deployment.md
# (Container). Both stages track one Docker Hardened Images tag, pinned by
# digest; Renovate moves them together, and release.yml republishes the image
# when only these lines change. The tag names the full Node and Alpine versions;
# a PR that moves them gets a Docker Scout comparison (base-image.yml).

FROM dhi.io/node:24.22.0-alpine3.24-dev@sha256:7aff626d8cb36fd5a7bc926b6922fb9b40af4cf046f285fa45c1f1712bacd4b1 AS build
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

FROM dhi.io/node:24.22.0-alpine3.24@sha256:0b55cdd8c105b9823b26140f07a26c0fc8531fbc2cdbbdfc6e058f24c1762be5
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
    OAUTH_STORE=file:///data/oauth-store.json
USER 1000:1000
EXPOSE 3000
VOLUME ["/data"]
ENTRYPOINT ["node", "/app/dist/index.js"]
