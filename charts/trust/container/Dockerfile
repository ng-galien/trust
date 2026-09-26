# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE} AS build
WORKDIR /opt/trust
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY . .
RUN npm ci --no-audit --no-fund
RUN npx tsc -b \
 && npm run package:documentation --workspace=@trust/runtime \
 && npm run build --workspace=@trust/web \
 && npm run package:skill --workspace=@trust/runner \
 && npm run build --workspace=@trust-extension/coordination \
 && npm run build --workspace=@trust-extension/mobile-companion \
 && npm run build --workspace=@trust-extension/dragon-heist
RUN npm prune --omit=dev --no-audit --no-fund

FROM ${NODE_IMAGE} AS runtime
ARG SOURCE_REVISION=unversioned
LABEL org.opencontainers.image.title="TRUST server" \
      org.opencontainers.image.version="0.1.0" \
      org.opencontainers.image.revision="${SOURCE_REVISION}"
ENV NODE_ENV=production TRUST_INSTALL_ROOT=/opt/trust
WORKDIR /opt/trust
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=node:node /opt/trust /opt/trust
RUN mkdir -p /var/lib/trust && chown node:node /var/lib/trust
USER node
EXPOSE 4173
STOPSIGNAL SIGTERM
CMD ["node", "packages/trust-shell/bin/trust.js", "server", "start"]
