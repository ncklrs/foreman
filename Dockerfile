# Build stage
FROM node:20-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src/ ./src/

RUN npx tsc

# Production stage
FROM node:20-slim

RUN apt-get update -qq && \
    apt-get install -y --no-install-recommends \
    git \
    ripgrep \
    docker.io \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY --from=builder /app/dist ./dist
COPY foreman.example.toml ./foreman.example.toml

ENV NODE_ENV=production

EXPOSE 8080

ENTRYPOINT ["node", "dist/cli.js"]
CMD ["--watch", "--no-tui", "--api", "--api-port", "8080"]
