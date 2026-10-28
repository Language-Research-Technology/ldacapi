FROM node:24-slim AS base
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*
ENV COREPACK_HOME=/usr/local/share/corepack \
  pnpm_config_store_dir=/pnpm-store \
  CHECKPOINT_DISABLE=1
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable && corepack install && chmod -R a+rX "$COREPACK_HOME"

FROM base AS build
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store pnpm install --frozen-lockfile --ignore-scripts
COPY src/admin src/admin
RUN pnpm build

FROM base AS runtime
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store pnpm install --frozen-lockfile --prod --ignore-scripts \
  && pnpm rebuild
COPY prisma.config.ts ./
COPY prisma prisma
COPY scripts scripts
COPY src src
RUN pnpm exec prisma generate
COPY --from=build /app/src/admin/public/admin.css src/admin/public/
# node_modules is fixed at build time; pnpm's pre-run install check would need the network
ENV NODE_ENV=production \
  LDACAPI_HOST=0.0.0.0 \
  COREPACK_ENABLE_NETWORK=0 \
  pnpm_config_verify_deps_before_run=false
EXPOSE 8080
USER node
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.LDACAPI_PORT || 8080}/api/capabilities`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "src/index.ts"]
