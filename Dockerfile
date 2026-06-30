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
# NODE_ENV=production is baked into the IMAGE so the fail-closed auth guard
# (assertAuthEnv) and production behavior are always active.
ENV NODE_ENV=production
EXPOSE 3000
# Exec form so the process receives SIGTERM/SIGINT (graceful shutdown handlers).
CMD ["./node_modules/.bin/tsx", "apps/api/src/index.ts"]
