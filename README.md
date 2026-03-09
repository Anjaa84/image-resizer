# Image Resizer — Backend API

A production-grade Image Resizer SaaS backend: upload originals, request transforms (resize, format conversion, crop, rotate, grayscale), poll job status, and download results.

---

## Tech Stack

| Layer       | Technology              |
|-------------|-------------------------|
| Runtime     | Node.js 20              |
| Language    | TypeScript 5            |
| HTTP        | Fastify 4               |
| Database    | MongoDB 7 + Mongoose 8  |
| Cache/Queue | Redis 7 + BullMQ 5      |
| Image proc. | Sharp (libvips)         |
| Validation  | Zod                     |
| Logging     | Pino (structured JSON)  |
| Container   | Docker + Compose        |

---

## Quick Start (Docker)

The fastest way to run the full stack:

```bash
# 1. Copy and configure environment
cp .env.example .env

# 2. Build and start all four services
docker compose up --build

# 3. Verify the API is up
curl http://localhost:3000/health
```

That starts:
- **`api`** — Fastify HTTP server on port 3000
- **`worker`** — BullMQ image processing worker
- **`mongo`** — MongoDB on port 27017
- **`redis`** — Redis on port 6379

MongoDB and Redis health checks must pass before the API and worker start. The `api` service exposes its own health check at `GET /health`.

To stop and remove all containers and volumes:
```bash
docker compose down -v
```

---

## Local Development (without Docker)

Use this when you want hot reload and direct access to the TypeScript source.

### Prerequisites

- Node.js 20+
- MongoDB 7 running locally (or via Docker — see below)
- Redis 7 running locally (or via Docker — see below)

### Option A: Run only the dependencies in Docker

```bash
# Start just MongoDB and Redis
docker compose up mongo redis

# Then run the app locally
cp .env.example .env
# Edit .env: set MONGO_URI=mongodb://localhost:27017/image_resizer
#            set REDIS_HOST=localhost
npm install
npm run dev           # API server with hot reload (terminal 1)
npm run dev:worker    # Worker with hot reload (terminal 2)
```

### Option B: Install MongoDB and Redis locally

```bash
# macOS with Homebrew
brew install mongodb-community redis
brew services start mongodb-community
brew services start redis

cp .env.example .env
# Edit .env: set MONGO_URI=mongodb://localhost:27017/image_resizer
#            set REDIS_HOST=localhost
npm install
npm run dev           # terminal 1
npm run dev:worker    # terminal 2
```

---

## Environment Variables

Copy `.env.example` to `.env`. All variables have working defaults except `MONGO_URI`.

| Variable                        | Default                        | Description                                                     |
|---------------------------------|--------------------------------|-----------------------------------------------------------------|
| `NODE_ENV`                      | `development`                  | `development` / `production` / `test`                           |
| `PORT`                          | `3000`                         | HTTP listen port                                                |
| `HOST`                          | `0.0.0.0`                      | HTTP bind address                                               |
| `MONGO_URI`                     | *(required)*                   | MongoDB connection string                                       |
| `REDIS_HOST`                    | `localhost`                    | Redis host (`redis` in Docker Compose)                          |
| `REDIS_PORT`                    | `6379`                         | Redis port                                                      |
| `REDIS_PASSWORD`                | —                              | Redis password (optional)                                       |
| `LOG_LEVEL`                     | `info`                         | `fatal` / `error` / `warn` / `info` / `debug` / `trace`        |
| `STORAGE_DRIVER`                | `local`                        | `local` (filesystem) or `s3` (AWS S3)                          |
| `UPLOAD_DIR`                    | `./uploads`                    | Base directory for local storage                                |
| `APP_BASE_URL`                  | `http://localhost:3000`        | Public base URL for constructing file download URLs             |
| `MAX_UPLOAD_BYTES`              | `52428800`                     | Upload size hard cap in bytes (default: 50 MB)                  |
| `MAX_IMAGE_WIDTH`               | `10000`                        | Maximum transform output width in pixels                        |
| `MAX_IMAGE_HEIGHT`              | `10000`                        | Maximum transform output height in pixels                       |
| `ALLOWED_MIME_TYPES`            | *(all Sharp formats)*          | Comma-separated upload allow-list (e.g. `image/jpeg,image/png`) |
| `QUEUE_CONCURRENCY`             | `5`                            | Parallel Sharp jobs per worker process                          |
| `QUEUE_MAX_ATTEMPTS`            | `3`                            | Total job attempts (1 initial + retries)                        |
| `QUEUE_BACKOFF_DELAY_MS`        | `2000`                         | Initial exponential backoff delay in ms                         |
| `SYNC_MAX_SOURCE_BYTES`         | `1048576`                      | Max source file size for inline (sync) transforms               |
| `SYNC_MAX_OUTPUT_PIXELS`        | `2073600`                      | Max output pixel count for inline transforms (1920×1080)        |
| `SYNC_MAX_COMPLEXITY`           | `1`                            | Max non-resize ops (rotate/grayscale) for inline transforms     |
| `RATE_LIMIT_MAX`                | `100`                          | Max requests per window per IP                                  |
| `RATE_LIMIT_WINDOW_MS`          | `60000`                        | Rate limit window in ms (60 s)                                  |
| `SHUTDOWN_TIMEOUT_MS`           | `10000`                        | Graceful shutdown hard timeout in ms                            |
| `STORAGE_DELETE_ON_ASSET_DELETE`| `false`                        | Also purge bytes from storage on `DELETE /images/:id`           |

For S3 storage, also set: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `S3_BUCKET`.

---

## API Reference

Base URL: `http://localhost:3000`

### Health & Readiness

```bash
# Liveness — is the process alive?
curl http://localhost:3000/health

# Readiness — are all dependencies reachable?
curl http://localhost:3000/ready
```

### Upload an image

```bash
curl -X POST http://localhost:3000/api/v1/images \
  -F "file=@/path/to/photo.jpg"
```

Response (`201`):
```json
{
  "assetId": "6650a1b2c3d4e5f6a7b8c9d0",
  "status": "ready",
  "mimeType": "image/jpeg",
  "width": 3840,
  "height": 2160,
  "sizeBytes": 4194304,
  "url": "http://localhost:3000/files/originals/abc123.jpg"
}
```

If you upload the same file a second time, the existing asset is returned (`deduplicated: true`).

### Request a transform

```bash
# Async (large file — returns 202 + jobId to poll)
curl -X POST http://localhost:3000/api/v1/images/6650a1b2c3d4e5f6a7b8c9d0/transform \
  -H "Content-Type: application/json" \
  -d '{"width": 800, "height": 600, "format": "webp", "quality": 85}'

# Sync (small file — returns 200 with the result immediately)
curl -X POST http://localhost:3000/api/v1/images/6650a1b2c3d4e5f6a7b8c9d0/transform \
  -H "Content-Type: application/json" \
  -d '{"width": 400, "height": 300, "format": "webp"}'
```

Transform parameters:

| Field       | Type    | Default  | Values                                               |
|-------------|---------|----------|------------------------------------------------------|
| `width`     | integer | required | 1–`MAX_IMAGE_WIDTH`                                  |
| `height`    | integer | required | 1–`MAX_IMAGE_HEIGHT`                                 |
| `format`    | string  | `webp`   | `jpeg` `png` `webp` `avif`                           |
| `quality`   | integer | `85`     | 1–100                                                |
| `fit`       | string  | `cover`  | `cover` `contain` `fill` `inside` `outside`          |
| `rotate`    | integer | `0`      | -360–360 (degrees)                                   |
| `grayscale` | boolean | `false`  | `true` `false`                                       |

### Poll job status

```bash
curl http://localhost:3000/api/v1/jobs/6650a1b2c3d4e5f6a7b8c9d1
```

Response (`queued`):
```json
{ "jobId": "...", "status": "queued", "createdAt": "2024-01-01T00:00:00.000Z" }
```

Response (`completed`):
```json
{
  "jobId": "...",
  "status": "completed",
  "startedAt": "2024-01-01T00:00:01.000Z",
  "completedAt": "2024-01-01T00:00:02.000Z",
  "outputAsset": {
    "assetId": "...",
    "url": "http://localhost:3000/files/derived/abc123/800x600_webp_q85.webp",
    "width": 800,
    "height": 600,
    "mimeType": "image/webp",
    "sizeBytes": 32768
  }
}
```

### Get asset metadata

```bash
curl http://localhost:3000/api/v1/images/6650a1b2c3d4e5f6a7b8c9d0
```

### Download image bytes

```bash
curl -O -J http://localhost:3000/api/v1/images/6650a1b2c3d4e5f6a7b8c9d0/download
```

### List images (paginated)

```bash
curl "http://localhost:3000/api/v1/images?page=1&limit=20&status=ready&type=original"
```

### Delete an asset

```bash
curl -X DELETE http://localhost:3000/api/v1/images/6650a1b2c3d4e5f6a7b8c9d0
```

Soft-deletes the MongoDB record. Set `STORAGE_DELETE_ON_ASSET_DELETE=true` to also remove the file bytes.

---

## Architecture Summary

```
Client
  │
  │ multipart upload / JSON request
  ▼
Fastify API (src/server.ts, src/app.ts)
  │  • Zod validation (request body, query params, path params)
  │  • Rate limiting — @fastify/rate-limit backed by Redis
  │  • Size + MIME type enforcement
  │
  ├─────────────────────────┐
  ▼                         ▼
MongoDB                   Redis / BullMQ
(asset + job metadata)    (job queue)
                               │
                               ▼
                     BullMQ Worker (src/workers/)
                       • Dequeues transform jobs
                       • Reads original from storage
                       • Sharp pipeline: rotate → resize → grayscale → toFormat
                       • Writes output to storage
                       • Updates asset + job status in MongoDB
```

**Key design decisions:**

- **API and worker are separate processes** — CPU-bound Sharp transforms never block the HTTP event loop. Each tier scales independently.
- **Hybrid sync/async execution** — Small transforms (≤1 MB source, ≤1920×1080 output) run inline in the HTTP request (returns `200`). Larger transforms are queued (returns `202` + `jobId`). Thresholds are config-driven.
- **Content-addressed storage** — Files are keyed by SHA-256 hash (originals) and transform signature (derived assets). Uploading the same file or requesting the same transform twice returns the existing asset without extra work.
- **Non-throwing health checks** — `GET /ready` runs MongoDB, Redis, and storage checks concurrently with per-check timeouts. Partial failures report per-dependency status without crashing the handler.

See [architecture.md](./architecture.md) for a full breakdown of every design decision.

---

## Scripts

```bash
# Development
npm run dev            # API server with hot reload
npm run dev:worker     # Worker with hot reload
npm run db:indexes     # Sync MongoDB indexes (run before first production deploy)

# Production
npm run build          # Compile TypeScript → dist/
npm run start          # Start compiled API server
npm run start:worker   # Start compiled worker

# Quality
npm run typecheck      # Type-check without emitting files
npm run lint           # ESLint
npm test               # Run all tests (Vitest)
npm run test:watch     # Watch mode
npm run test:coverage  # Coverage report (lcov + text)
```
