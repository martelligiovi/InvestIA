# Node 24 supports native TypeScript stripping and pnpm 11's Node engine.
FROM node:24.14.0-bookworm-slim AS base
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates \
    && apt-get clean

FROM base AS build
WORKDIR /app
RUN npm install --global pnpm@11.17.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
# Copy allowed sources before installing so host links cannot overwrite Linux links.
COPY packages ./packages
RUN pnpm install --frozen-lockfile
RUN pnpm build
RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/python -m pip install --no-cache-dir -r packages/adapter-user-scanner/python/requirements.txt

FROM base AS runtime
ENV NODE_ENV=production \
    PYTHON=/opt/venv/bin/python \
    PATH="/opt/venv/bin:${PATH}" \
    PYTHONDONTWRITEBYTECODE=1
WORKDIR /app
# Keep workspace symlinks, tool adapters, TS sources and frontend dist.
# Scanner and Python dependencies are copied in-image; nothing installs at startup.
COPY --from=build --chown=node:node /app /app
COPY --from=build /opt/venv /opt/venv
# WORKDIR remains root-owned; only the private report directory needs writes.
RUN install -d -m 0700 -o node -g node /app/.scanner-runs
USER node
EXPOSE 4317
CMD ["node", "--experimental-strip-types", "packages/backend/src/main.ts"]
