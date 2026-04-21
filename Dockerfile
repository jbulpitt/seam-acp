FROM node:22-bookworm-slim AS build

WORKDIR /app
# better-sqlite3 needs node-gyp + a C++ toolchain at install time.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build \
    && npm prune --omit=dev

# ---

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    DATA_DIR=/data \
    REPOS_ROOT=/repos \
    HEALTH_PORT=3000

# Install GitHub Copilot CLI globally so the bot can spawn `copilot --acp`.
# Set --build-arg INSTALL_COPILOT_CLI=false to skip (e.g. if you mount your own).
ARG INSTALL_COPILOT_CLI=true
RUN if [ "$INSTALL_COPILOT_CLI" = "true" ]; then \
        npm install -g @github/copilot --no-audit --no-fund \
            && npm cache clean --force; \
    fi

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# `node` user already exists in the base image; make /data writable for it.
RUN mkdir -p /data && chown -R node:node /data
USER node

VOLUME ["/data"]
EXPOSE 3000

ENTRYPOINT ["node", "dist/index.js"]

