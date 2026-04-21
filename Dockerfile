FROM node:22-slim AS build

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---

FROM node:22-slim AS runtime

ENV NODE_ENV=production

# Install GitHub Copilot CLI globally.
# (Adjust if you prefer to bring it in via a different channel.)
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @github/copilot

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY --from=build /app/dist ./dist

USER node
ENV DATA_DIR=/data
VOLUME ["/data"]

EXPOSE 3000
ENTRYPOINT ["node", "dist/index.js"]
