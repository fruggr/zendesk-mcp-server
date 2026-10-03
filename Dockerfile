# syntax=docker/dockerfile:1

# Hardened, distroless image for the HTTP transport only: docs/http-deployment.md
# (Container). Both stages track one Docker Hardened Images tag, pinned by
# digest; Renovate moves them together, and release.yml republishes the image
# when only these lines change.

FROM dhi.io/node:24-alpine3.24-dev@sha256:0b0cc56ea256e9733ae8813e29a67816f4ce15379f5de6de72d088945f981332 AS build
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

FROM dhi.io/node:24-alpine3.24@sha256:732e532a85421f18219acffc899b0c41b2376d8f9ac47cf2d9e1ad35e014a957
ARG VERSION=0.0.0
LABEL org.opencontainers.image.title="zendesk-mcp-server" \
      org.opencontainers.image.description="Zendesk MCP server, HTTP transport (OAuth 2.1 authorization server included)." \
      org.opencontainers.image.source="https://github.com/fruggr/zendesk-mcp-server" \
      org.opencontainers.image.documentation="https://github.com/fruggr/zendesk-mcp-server/blob/main/docs/http-deployment.md#container" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}"
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
