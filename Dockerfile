FROM node:24-slim AS base
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*
ENV COREPACK_HOME=/usr/local/share/corepack \
  COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  pnpm_config_store_dir=/pnpm-store
WORKDIR /app
COPY package.json ./
RUN corepack enable && corepack install && chmod -R a+rX "$COREPACK_HOME"
# What `prisma generate` reads in postinstall
COPY pnpm-lock.yaml pnpm-workspace.yaml prisma.config.ts ./
COPY prisma prisma
COPY src/configuration.ts src/
COPY src/oidc/keys.ts src/oidc/

FROM base AS build
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store pnpm install --frozen-lockfile
COPY src/admin src/admin
RUN pnpm build

FROM base AS runtime
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store pnpm install --frozen-lockfile --prod
COPY scripts scripts
COPY src src
COPY --from=build /app/src/admin/public/admin.css src/admin/public/
# node_modules is fixed at build time; pnpm's pre-run install check would need the network
ENV NODE_ENV=production \
  LDACAPI_HOST=0.0.0.0 \
  COREPACK_ENABLE_NETWORK=0 \
  pnpm_config_verify_deps_before_run=false \
  CHECKPOINT_DISABLE=1
EXPOSE 8080
USER node
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.LDACAPI_PORT || 8080}/api/capabilities`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "src/index.ts"]
