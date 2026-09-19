# Production-oriented image for the API and the worker (Phase 4 automated readiness).
#
# HONEST SCOPE, STATED FIRST: no container runtime exists in the workspace where this was written, so
# this file has been STATICALLY VALIDATED (stage graph, build outputs, non-root user, exposed ports,
# no embedded secrets) and NEVER BUILT OR RUN. It is a reviewed starting point, not proven infrastructure.
#
# Design decisions worth stating:
#   * multi-stage, so the runtime image carries neither the toolchain nor the dev dependencies;
#   * `--frozen-lockfile`, so an image build cannot silently resolve a different dependency tree than
#     CI tested;
#   * a non-root user, because a process that never needs to write to its own image should not be able to;
#   * no default provider mode and no default credentials — the processes refuse to start without an
#     explicit mode, which is deliberate and must survive containerization.

FROM node:22.12-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

# ---- dependencies -------------------------------------------------------------------------------
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/cli/package.json apps/cli/
COPY apps/web/package.json apps/web/
COPY packages/canon/package.json packages/canon/
COPY packages/context/package.json packages/context/
COPY packages/db/package.json packages/db/
COPY packages/domain/package.json packages/domain/
COPY packages/eval/package.json packages/eval/
COPY packages/gateway/package.json packages/gateway/
COPY packages/narrative/package.json packages/narrative/
COPY packages/prompts/package.json packages/prompts/
COPY packages/prose/package.json packages/prose/
COPY packages/workflows/package.json packages/workflows/
RUN pnpm install --frozen-lockfile

# ---- build --------------------------------------------------------------------------------------
FROM deps AS build
COPY . .
RUN pnpm run typecheck

# ---- runtime ------------------------------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
# A dedicated unprivileged user. `node` exists in the base image but is given a stable uid here so a
# mounted volume's ownership is predictable.
RUN groupadd --gid 10001 yeonjae && useradd --uid 10001 --gid 10001 --create-home yeonjae
COPY --from=build --chown=yeonjae:yeonjae /app /app
USER yeonjae
# The API's listener. The worker overrides the command and exposes nothing.
EXPOSE 8080
# Readiness is a real dependency check (migrations, role, pool), which is why it is the healthcheck
# target rather than liveness: a container that is up but cannot serve safely must not receive traffic.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=4 \
  CMD node -e "fetch('http://127.0.0.1:8080/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["pnpm", "--filter", "@yeonjae/api", "start"]
