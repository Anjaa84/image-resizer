# ─── Stage 1: Builder ─────────────────────────────────────────────────────────
# Compiles TypeScript to JavaScript. This stage is discarded after the build —
# only the compiled output is copied to the runner stage, keeping the final
# image free of TypeScript dev dependencies and source maps.
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies first (separate layer) so that npm install is only
# re-run when package.json or package-lock.json changes — not on every
# source file change. This is the single most impactful layer-caching trick.
COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

# ─── Stage 2: Runner ──────────────────────────────────────────────────────────
# Minimal production image. Contains only compiled JS, production node_modules,
# and the libvips runtime required by Sharp.
FROM node:20-alpine AS runner

# libvips is the image processing library that Sharp wraps. Installing it at
# the system level ensures Sharp can compile its native addon (if no prebuilt
# binary is available for this platform/OS) or link against the system library.
RUN apk add --no-cache vips-dev

WORKDIR /app

ENV NODE_ENV=production

# Reinstall only production dependencies. This avoids copying the full
# node_modules from the builder stage (which includes dev tools like TypeScript)
# and keeps the image size smaller.
COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

# Create runtime directories and a dedicated non-root user in a single layer.
# Running as non-root is a container security baseline — if Sharp or the app
# is compromised, the attacker cannot write to system directories.
RUN mkdir -p uploads logs && \
    addgroup -S appgroup && \
    adduser  -S appuser -G appgroup && \
    chown -R appuser:appgroup /app

USER appuser

EXPOSE 3000

# Liveness probe: the orchestrator (Kubernetes, ECS) uses this to decide whether
# to restart the container. Uses the lightweight /health endpoint which never
# checks external dependencies — only confirms the event loop is running.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

# Default command starts the API server.
# The worker is started by overriding this command in docker-compose.yml:
#   command: node dist/workers/image.worker.js
CMD ["node", "dist/server.js"]
