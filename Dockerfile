# Greenhouse — single self-contained image: the Hono API serves the built SPA,
# run via tsx (no separate compile step). Debian base (not Alpine): the `compute`
# tool's isolated-vm native addon builds reliably on glibc.

FROM node:22-bookworm-slim AS base
WORKDIR /app
# npm/pnpm registry — override for restricted networks, e.g.:
#   docker build --build-arg NPM_REGISTRY=https://registry.npmmirror.com/ .
ARG NPM_REGISTRY=https://registry.npmjs.org/
ENV npm_config_registry=${NPM_REGISTRY}
# Pin pnpm to match packageManager in package.json.
RUN npm install -g pnpm@11.9.0

# ── Build: install the full workspace (compiles native addons) + build the SPA ──
# NODE_ENV is left unset here so devDependencies (vite, tsx, drizzle-kit) install.
FROM base AS build
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY . .
RUN pnpm install --frozen-lockfile
# Vite builds the web bundle into repo-root public/, which the API serves at `/`.
RUN pnpm web:build

# ── Runtime: same filesystem, production env ──
FROM build AS runtime
# Build stamp: CI passes the git tag + commit sha so the running image knows
# exactly which code it is (surfaced at /health, see apps/api/src/routes/health.ts).
# Defaults are dev sentinels for a plain `docker build` with no --build-arg.
ARG APP_VERSION=0.0.0-dev
ARG APP_REVISION=unknown
# NODE_ENV=production is baked into the IMAGE so the fail-closed auth guard
# (assertAuthEnv) and production behavior are always active.
ENV NODE_ENV=production \
    APP_VERSION=${APP_VERSION} \
    APP_REVISION=${APP_REVISION}
# OCI image labels — provenance a registry (GHCR) reads for the package page.
LABEL org.opencontainers.image.title="Greenhouse" \
      org.opencontainers.image.description="Open-source, AI-native enterprise agent workbench" \
      org.opencontainers.image.source="https://github.com/linjiejim/greenhouse" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.revision="${APP_REVISION}" \
      org.opencontainers.image.licenses="MIT"
EXPOSE 3000
# Exec form so the process receives SIGTERM/SIGINT (graceful shutdown handlers).
CMD ["./node_modules/.bin/tsx", "apps/api/src/index.ts"]
