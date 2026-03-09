# Architecture — Image Resizer SaaS Backend

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Major Components](#2-major-components)
3. [Request Flow](#3-request-flow)
4. [Technology Choices](#4-technology-choices)
   - 4.1 [Fastify](#41-fastify)
   - 4.2 [MongoDB](#42-mongodb)
   - 4.3 [Why Image Binaries Do Not Live in MongoDB](#43-why-image-binaries-do-not-live-in-mongodb)
   - 4.4 [Storage Abstraction](#44-storage-abstraction)
   - 4.5 [Sharp](#45-sharp)
   - 4.6 [BullMQ + Redis](#46-bullmq--redis)
5. [Deduplication Strategy](#5-deduplication-strategy)
6. [Sync vs Async Processing Strategy](#6-sync-vs-async-processing-strategy)
7. [Scaling Model](#7-scaling-model)
8. [Where Kafka Fits Later](#8-where-kafka-fits-later)
9. [Known Bottlenecks](#9-known-bottlenecks)
10. [Security Considerations](#10-security-considerations)
11. [Reliability Considerations](#11-reliability-considerations)
12. [Folder Structure](#12-folder-structure)

---

## 1. System Overview

This backend is an asynchronous image processing pipeline exposed over HTTP. Clients upload an image and declare how they want it transformed — target dimensions, output format, quality. The API acknowledges the request immediately, persists the original file to a storage layer, records metadata in MongoDB, and enqueues a resize job. A separate worker process dequeues jobs, runs Sharp to perform the transformation, writes the result back to storage, and updates the job record so the client can retrieve the output URL.

The system is intentionally split across two independently scalable processes: an HTTP API and a compute worker. This separation is the central design decision — it prevents image processing from ever blocking the web server and allows each tier to scale in response to its own bottleneck.

```
┌─────────────────────────────────────────────────────────┐
│                        Client                           │
└───────────────────────┬─────────────────────────────────┘
                        │ HTTP (multipart upload)
                        ▼
┌─────────────────────────────────────────────────────────┐
│                    Fastify API                          │
│  • Validates input (Zod)                                │
│  • Writes original to Storage                           │
│  • Persists metadata to MongoDB                         │
│  • Enqueues job to BullMQ                               │
│  • Returns 202 Accepted + imageId                       │
└───────────┬─────────────────────────┬───────────────────┘
            │                         │
            ▼                         ▼
     ┌─────────────┐          ┌──────────────┐
     │   MongoDB   │          │  Redis/BullMQ│
     │  (metadata) │          │   (queue)    │
     └─────────────┘          └──────┬───────┘
                                     │
                                     ▼
                        ┌─────────────────────────┐
                        │     Worker Process       │
                        │  • Dequeues job          │
                        │  • Reads original file   │
                        │  • Sharp transform       │
                        │  • Writes output file    │
                        │  • Updates MongoDB doc   │
                        └─────────────────────────┘
```

---

## 2. Major Components

### Fastify API (`src/server.ts`, `src/app.ts`)
The HTTP entry point. Responsible only for accepting requests, validating them, persisting originals, and handing off to the queue. It has no Sharp dependency and performs no pixel work. Kept intentionally thin.

### Image Module (`src/modules/images/`)
The domain layer for the Image resource. Contains the Mongoose model (schema), Zod validation schemas, a service class that orchestrates the upload/enqueue flow, and a controller that is the HTTP adapter between Fastify and the service.

### Job Module (`src/modules/jobs/`)
Tracks the lifecycle of each processing job in MongoDB, mirroring BullMQ state into a queryable document store. This lets clients query job status through the REST API without coupling them to the internals of Redis.

### Queue (`src/queue/`)
A thin wrapper around BullMQ. Defines the `ImageResizeJobData` interface that is the contract between the API and the worker. The IORedis connection is shared across both the API process (for enqueueing) and the worker process (for dequeueing), with `maxRetriesPerRequest: null` as required by BullMQ.

### Storage (`src/storage/`)
A `StorageDriver` interface with concrete implementations for local disk and S3. Both the API (writing originals) and the worker (writing outputs) go through this abstraction. The active driver is selected at startup from `STORAGE_DRIVER` env var, making the storage backend a deployment-time concern, not a code concern.

### Worker (`src/workers/image.worker.ts`)
A standalone Node.js process. Runs a BullMQ `Worker` with configurable concurrency. Performs the Sharp transformation, writes the result, and updates both the Image document and Job document in MongoDB. Deployed as its own Docker service so it can be scaled independently from the API.

### Config (`src/config/index.ts`)
All environment variables parsed and validated through a Zod schema at process startup. If any required variable is missing or has the wrong shape, the process exits before binding to any port or queue. This is a hard fail-fast boundary.

---

## 3. Request Flow

### Upload path (synchronous portion)

```
POST /api/v1/images?width=800&height=600&format=webp&quality=85
  Content-Type: multipart/form-data

  1. Fastify parses multipart stream (@fastify/multipart)
  2. Zod validates query params — rejects invalid input with 422
  3. ImageService:
     a. Streams original file to StorageDriver → returns sourcePath
     b. Reads image metadata via Sharp (dimensions, mime type, size)
     c. Inserts Image document into MongoDB { status: 'pending' }
     d. Enqueues ImageResizeJobData to BullMQ
     e. Inserts Job document into MongoDB { status: 'queued' }
  4. API returns 202 Accepted:
     { imageId, jobId, status: 'pending' }
```

### Processing path (asynchronous — worker process)

```
  BullMQ dequeues job
  1. Worker fetches source file from StorageDriver
  2. Sharp pipeline:
       .resize(targetWidth, targetHeight)
       .toFormat(format, { quality })
       .toBuffer()
  3. StorageDriver.save(buffer, outputKey) → outputUrl
  4. MongoDB: Image { status: 'done', outputPath, outputUrl }
  5. MongoDB: Job { status: 'completed', completedAt }
  6. BullMQ marks job complete
```

### Polling path (client retrieves result)

```
GET /api/v1/images/:id
  → MongoDB lookup by _id
  → Returns { status, outputUrl } — client consumes outputUrl when status === 'done'
```

---

## 4. Technology Choices

### 4.1 Fastify

Fastify is chosen over Express for several concrete reasons rather than preference.

**Performance.** Fastify's HTTP router is built on a radix tree (`find-my-way`) and its serialization pipeline is driven by `fast-json-stringify`, which compiles JSON schemas to optimized serialization functions. At identical workloads Fastify consistently achieves higher requests-per-second than Express. For an API that must stay out of the way of the real compute work, raw HTTP throughput matters.

**Schema-first design.** Fastify treats JSON Schema as a first-class citizen for both input validation and output serialization. This aligns with the project's Zod-centric validation strategy and makes input contracts explicit at the route level rather than scattered through middleware.

**Plugin system.** Fastify's encapsulation model (`fastify-plugin`, `register`) makes it straightforward to compose features — multipart parsing, rate limiting, authentication — without the global mutation pitfalls common in Express middleware chains.

**Async-native.** Fastify's route handlers are async by default with proper error propagation. There is no need for `next(err)` patterns or wrapping async handlers.

**Built-in Pino integration.** Fastify ships with Pino as its logger. This project uses Pino throughout, so the integration is native with no glue code required.

### 4.2 MongoDB

MongoDB is appropriate here for the image metadata use case for the following reasons.

**Flexible metadata schema.** Image transformation requests vary — a resize job, a format conversion, a quality adjustment. The parameters attached to each image document may evolve as new transformation types are added (crop, rotate, watermark, filter). A document model accommodates this without requiring schema migrations that would lock a table on a relational database.

**Job and image lifecycle as documents.** Both `Image` and `Job` have a natural lifecycle represented as a status field with accompanying timestamps. This is a good fit for a document model — all state for a given image lives in one place and can be read in a single document fetch.

**Horizontal scalability.** MongoDB's replica sets and sharding model pair well with a horizontally scaled API tier. As request volume grows, read replicas can absorb status polling load without touching the primary.

**Developer velocity.** Mongoose's ODM layer provides typed schemas in TypeScript via the `IImage` / `IJob` interfaces, validated constraints at the persistence layer, and lean query helpers — all without the overhead of defining migrations.

### 4.3 Why Image Binaries Do Not Live in MongoDB

This is a critical design constraint that must be stated explicitly.

MongoDB's BSON document size limit is **16 MB**. Most production images — especially RAW, TIFF, or high-resolution JPEG files — exceed this. GridFS works around the limit by splitting files into 255 KB chunks, but it introduces serious problems:

- **Read amplification.** Reconstructing a 10 MB image from GridFS requires fetching ~40 chunks, reassembling them in memory, and streaming them out. This is IO-intensive work that belongs to a storage layer, not a database.
- **Memory pressure.** Holding large buffers in the MongoDB driver and application memory for serving files puts unnecessary pressure on the Node.js heap and the database server.
- **Throughput ceiling.** MongoDB is not designed or optimized to serve binary files with high concurrency. A dedicated object store (S3, GCS, or even nginx serving local files) will outperform it by orders of magnitude on file delivery.
- **Cost.** MongoDB storage is significantly more expensive per GB than S3-class object storage. Storing binaries in Mongo inflates operational cost with no benefit.

**The rule is: MongoDB holds metadata (paths, URLs, dimensions, status) — storage holds bytes.** Clients receive a `outputUrl` that points directly to the storage layer, never to a MongoDB-served binary.

### 4.4 Storage Abstraction

The `StorageDriver` interface (`src/storage/storage.interface.ts`) defines three operations: `save`, `getUrl`, and `delete`. Both `LocalStorage` and `S3Storage` implement this interface. The factory in `src/storage/index.ts` selects the implementation from `STORAGE_DRIVER` env var.

This abstraction serves several purposes:

- **Environment portability.** Local disk works for development and CI. S3 works for production. The application code has no conditional logic — it simply calls `storage.save(...)`.
- **Testability.** Tests can inject a mock `StorageDriver` without touching the filesystem or network.
- **Future extensibility.** Adding GCS, Azure Blob, or a CDN-backed driver requires implementing three methods and updating the factory — nothing else changes.
- **No coupling between API and worker.** Both processes call the same storage abstraction. Whether the file ends up on disk or in S3 is irrelevant to either process's logic.

Without this abstraction, storage driver selection would leak into `ImageService` and the worker, creating conditional branches that are hard to test and easy to break.

### 4.5 Sharp

Sharp is the correct choice for server-side image processing in Node.js for concrete technical reasons.

Sharp is a thin wrapper around **libvips**, a C-based image processing library that operates on streaming pipelines rather than loading full images into memory. libvips processes images in small tiles, which means memory consumption is proportional to a tile — not the full image — regardless of input dimensions. This makes it practical to resize a 50 MP TIFF on a machine with 512 MB of RAM.

Compared to alternatives:

- **Jimp** — pure JavaScript, no native dependency, but 5–10x slower and memory-heavy.
- **ImageMagick / GraphicsMagick** via `child_process` — spawns a subprocess per image, high overhead, difficult to pipeline, and harder to control concurrency.
- **Canvas / node-canvas** — GPU-accelerated in some environments but designed for drawing, not batch image transformation.

Sharp handles JPEG, PNG, WebP, AVIF, GIF, TIFF, and raw pixel buffers natively. AVIF support in particular is relevant for modern SaaS use cases where output file size matters for end-user performance.

### 4.6 BullMQ + Redis

**Why a queue at all?** Image resizing is CPU-bound. Running it synchronously on the HTTP event loop would monopolize the Node.js thread, degrading API responsiveness for every other request in flight. The only correct architectural answer is to move CPU-bound work off the request lifecycle.

**Why BullMQ over alternatives?**

- **Reliability primitives.** BullMQ provides at-least-once delivery, configurable retry with backoff, job TTL, and stalled job detection out of the box. These are production requirements, not nice-to-haves.
- **Redis as the broker.** Redis persistence (AOF/RDB) means jobs survive a process restart. Redis Streams (which BullMQ uses internally) are purpose-built for durable, ordered message delivery.
- **Concurrency control.** The `Worker` concurrency setting caps parallel Sharp processes per worker instance. This prevents OOM conditions when running on memory-constrained containers.
- **Observability.** BullMQ's queue metrics (waiting, active, completed, failed counts) can be scraped and graphed. Failed jobs remain inspectable in Redis until explicitly removed.
- **TypeScript support.** BullMQ is written in TypeScript. The `Queue<ImageResizeJobData>` generic provides type safety across the enqueue/dequeue boundary.

---

## 5. Deduplication Strategy

The system deduplicates work at two distinct levels: identical file uploads and identical transforms. Both use a lookup-before-enqueue pattern — the service checks whether an equivalent asset already exists and returns it immediately if so, without touching the queue or the storage layer.

### 5.1 Original deduplication — file hash

When a client uploads a file, Sharp reads the file header to detect the actual format, then the service computes a **SHA-256 hash of the raw file bytes**. Before creating any record, it queries:

```
assets.findOne({ 'file.hash': <sha256>, type: 'original', deletedAt: { $exists: false } })
```

If a match exists, the service returns the existing original asset directly. The file is not written to storage a second time and no new MongoDB document is created.

This handles the common case of a client uploading the same source image repeatedly — either by accident or as part of a retry loop. The `{ 'file.hash': 1 }` index makes this lookup a single index scan.

**What this does not cover:** two files with identical bytes but different intended semantics. In practice, identical bytes means identical content, so treating them as the same original is correct.

### 5.2 Derived asset deduplication — transform signature

Before enqueuing a resize job, the service computes a **transform signature**: a SHA-256 hash of the normalized, canonical transform parameters. It then queries:

```
assets.findOne({
  sourceAssetId: <originalId>,
  transformSignature: <signature>,
  deletedAt: { $exists: false }
})
```

The compound unique sparse index `{ sourceAssetId: 1, transformSignature: 1 }` makes this an index-point lookup. If a derived asset exists for that source + transform combination — regardless of its current status — the service returns it without enqueuing a new job.

This has an important implication for in-flight jobs: if a derived asset exists in `pending` or `processing` state, the second caller receives the same asset ID and can poll it to completion. Two clients requesting the same transform of the same image race to the same result, not to two independent jobs.

### 5.3 Transform signature computation

The signature is computed in `src/lib/transform-signature.ts`:

```
SHA-256(
  JSON.stringify({
    fit:     <normalized>,
    format:  <normalized>,
    height:  <number>,
    quality: <number>,
    width:   <number>,
  })
)
```

Keys are serialized in **fixed alphabetical order**, not insertion order. This is the critical correctness requirement: `{ width: 800, height: 600 }` and `{ height: 600, width: 800 }` must produce the same hash. Relying on JavaScript object key order would make the hash unstable across different callers.

The signature is auto-computed in the Mongoose `pre('validate')` hook on `AssetSchema`, so it is impossible for a derived asset document to be saved without a valid, current signature. It is never set manually by application code.

### 5.4 Why the compound index is sparse

Original assets have no `sourceAssetId` and no `transformSignature`. A non-sparse unique index would index all originals under a shared null key and immediately produce a uniqueness conflict. `sparse: true` excludes documents where either field is absent, so originals are invisible to this index and only derived assets participate in the uniqueness constraint.

### 5.5 Deduplication flow summary

```
Upload request arrives
  │
  ├─ Compute file SHA-256
  │    └─ assets.findOne({ 'file.hash' })
  │         ├─ HIT  → return existing original, skip storage write
  │         └─ MISS → write to storage, create original asset doc
  │
  └─ Compute transform signature
       └─ assets.findOne({ sourceAssetId, transformSignature })
            ├─ HIT  → return existing derived asset + job, skip enqueue
            └─ MISS → create derived asset (pending), enqueue job
```

---

## 6. Sync vs Async Processing Strategy

The system uses a **hybrid execution model**: `POST /api/v1/images/:id/transform` either runs the transform inline (sync, returns `200`) or enqueues it (async, returns `202`). The decision is made per-request based on configurable thresholds.

### Decision logic

A transform is executed synchronously only when ALL of the following are true:

1. The source file is ≤ `SYNC_MAX_SOURCE_BYTES` (default 1 MB)
2. The output canvas is ≤ `SYNC_MAX_OUTPUT_PIXELS` (default 1920×1080 = ~2 MP)
3. The number of non-resize operations (rotate, grayscale) is ≤ `SYNC_MAX_COMPLEXITY` (default 1)

If any threshold is exceeded, the job is enqueued and the client receives a `202 Accepted` with a `jobId` to poll.

### Why the hybrid model

**Synchronous path** gives instant responses for common use cases — a small thumbnail or a format conversion of a compressed image. No polling, no job records, no BullMQ overhead. The client gets the output asset back in the `200` response body.

**Asynchronous path** keeps API latency predictable for large or complex transforms. Sharp's CPU time on a 50 MP TIFF can be several seconds. Blocking an HTTP connection for that duration is untenable — it ties up a socket and makes the client responsible for very long timeouts. The async model means the API always returns quickly and the worker retries on failure without the client resubmitting.

### Deduplication across both paths

The same deduplication check (`findOrCreateDerivedAsset`) runs on both paths. If a derived asset already exists for the `(sourceAssetId, transformSignature)` pair — regardless of how it was produced — the request is short-circuited and returns the existing asset. Two concurrent callers requesting the same transform of the same image converge on the same result.

### Threshold tuning

| Variable                | Default     | Guidance                                                            |
|-------------------------|-------------|---------------------------------------------------------------------|
| `SYNC_MAX_SOURCE_BYTES` | `1048576`   | Lower to push more to the worker; raise for faster small-file paths |
| `SYNC_MAX_OUTPUT_PIXELS`| `2073600`   | ~2 MP; stays well within a typical 512 MB worker memory budget      |
| `SYNC_MAX_COMPLEXITY`   | `1`         | `0` = resize-only sync; `1` = resize + one extra op (rotate or grayscale) |

---

## 7. Scaling Model

### API tier

The Fastify API is stateless. Multiple replicas can sit behind any L7 load balancer (nginx, AWS ALB, Cloudflare). Shared state lives in MongoDB and Redis — not in process memory. Rate limiting is backed by Redis via `@fastify/rate-limit`, so limits are enforced consistently across all replicas.

### Worker tier

Workers are independent processes with no shared in-process state. Scaling horizontally is as simple as increasing the Docker Compose replica count or adding Kubernetes worker pods. BullMQ's Redis-backed queue ensures each job is processed by exactly one worker regardless of how many are running.

Scaling vertically (more CPUs per worker host) is effective too: increasing `QUEUE_CONCURRENCY` allows more parallel Sharp processes on machines with more cores and memory.

### MongoDB

At moderate scale, a MongoDB replica set provides read scaling via secondary reads for status polling queries. At high scale, time-based or hash-based sharding on `_id` distributes write load across shards. Indexes on `status` and `createdAt` are essential as the `images` collection grows.

### Redis

Redis Cluster provides horizontal scaling of the queue when a single Redis node becomes a bottleneck. BullMQ supports Redis Cluster natively. For most workloads at this scale, a single Redis instance with persistence enabled and a read replica is sufficient.

### Summary table

| Bottleneck             | Horizontal scale action                        |
|------------------------|------------------------------------------------|
| API request volume     | Add API replicas behind load balancer          |
| Queue throughput       | Add worker replicas                            |
| Job concurrency/memory | Increase `QUEUE_CONCURRENCY` per worker        |
| DB read latency        | Add MongoDB read replicas, optimize indexes    |
| Storage throughput     | S3 scales natively; local disk does not        |
| Queue depth            | Redis Cluster if single node saturates         |

---

## 8. Where Kafka Fits Later

BullMQ on Redis is the right choice at this stage. It is operationally simple, well-supported, and sufficient for thousands of jobs per minute.

Kafka becomes relevant when the system crosses specific thresholds or requirements:

### Long-term event retention
BullMQ removes completed jobs (configurable). Kafka retains events indefinitely by default. If downstream systems need to replay the history of all image transformation events — for audit trails, billing reconciliation, or rebuilding derived state — Kafka is the appropriate substrate.

### Fan-out to multiple consumers
If a completed image transform should trigger multiple independent downstream actions (notify a CDN to invalidate a cache, update a billing service, emit a webhook to a client's endpoint, update a search index), BullMQ requires explicit chaining of queues. Kafka consumer groups allow any number of independent consumers to subscribe to the same event stream without coordination.

### Cross-service event bus
If this backend becomes one service in a larger platform (user service, billing service, notification service), Kafka acts as the durable event bus that decouples producers from consumers. A `image.resized` Kafka topic can be consumed by the notification service to send an email and by the billing service to record a usage event — independently, without the image service knowing about either.

### Where to insert Kafka

The natural insertion point is as an output from the worker. Rather than (or in addition to) updating MongoDB directly, the worker publishes an `image.resized` or `image.failed` event to Kafka. Downstream consumers handle their own concerns. The queue for intake (BullMQ) and the event bus for output (Kafka) are complementary, not alternatives.

---

## 9. Known Bottlenecks

### Sharp CPU saturation on the worker
Sharp/libvips is CPU-intensive. A worker running high concurrency on a low-CPU container will saturate its CPU, increasing job latency and stalling the queue. The concurrency setting must be tuned against the worker's actual CPU allocation. Monitoring queue depth and active job count is essential to detect this early.

### Large file uploads blocking the upload endpoint
Fastify's multipart plugin streams file data, but very large files (100 MB+) over slow connections will hold a socket open for a long time. A reverse proxy (nginx, Cloudflare) with a generous-but-bounded client upload timeout and a maximum body size limit at the edge prevents slow-upload denial of service.

### MongoDB write amplification on job status updates
Every job produces at minimum three writes: insert Image (pending), insert Job (queued), update Image (done/failed), update Job (completed/failed). At high throughput this is significant write load. Batching status updates or moving hot-path job state to Redis (with MongoDB as the durable store only for terminal states) reduces write pressure.

### Redis as a single point of failure
If Redis goes down, the queue stops — no new jobs can be enqueued and workers cannot dequeue. A Redis replica set with Sentinel or Redis Cluster provides HA. BullMQ's `stalledInterval` setting also ensures jobs that were active during a crash are re-queued automatically.

### Storage I/O on the worker
The worker reads the original file and writes the output file on every job. If `STORAGE_DRIVER=local` and the upload directory is on a slow disk or a network mount (NFS), this becomes a latency bottleneck. S3 with Transfer Acceleration and workers co-located in the same AWS region eliminates this.

---

## 10. Security Considerations

### Input validation — always reject at the boundary
All multipart uploads, query parameters, and JSON bodies are validated with Zod before they touch the service layer. Unknown fields are stripped. Numeric parameters (width, height, quality) are bounded. This prevents trivially malformed input from reaching Sharp.

### File type validation — do not trust Content-Type
The client-supplied MIME type in a multipart request is untrustworthy. Sharp detects the actual image format by reading the file header, not the declared MIME type. An attacker who uploads a disguised SVG (which can contain JavaScript) or a zip bomb is rejected before any processing occurs.

`ALLOWED_MIME_TYPES` provides a second layer of control: even if Sharp can decode a format, the API will reject it if it is not in the configured allow-list. This lets operators restrict acceptable input to a minimal set without code changes.

### Upload and dimension limits
`MAX_UPLOAD_BYTES` (default 50 MB) is enforced at two layers: the `@fastify/multipart` plugin cuts the stream before it is fully read, and the service layer performs a secondary check on the buffered size.

`MAX_IMAGE_WIDTH` and `MAX_IMAGE_HEIGHT` (default 10,000 px) cap the transform output dimensions. Requesting a 100,000×100,000 output would allocate ~40 GB of memory on the worker — these limits prevent that attack surface.

### Output path traversal
Storage keys are derived from SHA-256 content hashes and MongoDB ObjectIds — never from user-supplied filenames. `LocalStorage.resolvePath()` additionally verifies that the resolved path stays within `baseDir`, rejecting any key containing `../` sequences.

### Rate limiting
`@fastify/rate-limit` is applied globally with Redis as the backing store, so limits are consistent across all API replicas. Per-IP limits prevent single clients from flooding the upload endpoint or exhausting the queue. Configure with `RATE_LIMIT_MAX` (default 100 req/min per IP).

### Safe error responses
Unexpected errors (5xx) never surface internal details to the client. Stack traces, raw database error messages, and internal paths are logged server-side only. The client always receives a stable `{ statusCode, error, message, code, requestId }` shape. The `requestId` allows support to correlate the client-visible error with the server-side log entry.

### Worker process isolation
The worker runs as a non-root user inside Docker (`appuser` in the Dockerfile). Sharp is sandboxed to the application directory. The worker has no HTTP surface area — it communicates only through Redis and MongoDB, both of which should be on a private network with no public exposure.

### Secret management
Credentials (MongoDB URI, Redis password, AWS keys) must never be committed to the repository. They are passed via environment variables and validated at startup. In production, secrets should be injected via a secrets manager (AWS Secrets Manager, HashiCorp Vault, Kubernetes Secrets) rather than plaintext `.env` files.

---

## 11. Reliability Considerations

### Graceful shutdown
Both the API (`server.ts`) and worker (`image.worker.ts`) handle `SIGINT` and `SIGTERM`. The shutdown sequence is ordered:

1. Stop accepting new HTTP connections (API) / new BullMQ jobs (worker)
2. Wait for in-flight requests / active jobs to complete
3. Drain the BullMQ queue (API: flush any pending `queue.add()` calls)
4. Close MongoDB, then Redis — in that order to avoid DB operations after disconnection

A hard timeout (`SHUTDOWN_TIMEOUT_MS`, default 10 s) force-kills the process if any step stalls. This prevents the container from hanging indefinitely and triggering `SIGKILL` from the orchestrator after its own timeout, which could leave jobs in `active` state until BullMQ's stall detection reclaims them.

The `isShuttingDown` guard prevents double-shutdown if multiple signals arrive in quick succession (e.g., `SIGTERM` followed immediately by `SIGINT` from Docker Compose).

### Job retries and backoff
BullMQ is configured with `QUEUE_MAX_ATTEMPTS` (default 3) and exponential backoff starting at `QUEUE_BACKOFF_DELAY_MS` (default 2 s): attempt 1 → 2 s, attempt 2 → 4 s, attempt 3 → 8 s. Transient failures (storage unavailable, MongoDB timeout) are retried automatically. Permanent failures (corrupt input, unsupported format) exhaust retries and land in the `failed` state — visible in the Redis queue and recorded in the Job document as `errorMessage`.

### Idempotent job processing
Each job carries a `bullJobId` and an `outputAssetId`. If a worker crashes mid-job, BullMQ's stalled job detection re-queues it. The worker writes to the same output storage key (content-addressed, so overwriting is safe) and uses `updateAssetStatus` (update by `_id`) rather than insert, making re-processing safe.

### Health and readiness probes
`GET /health` — liveness probe. Returns `200` unconditionally while the event loop is running. Never checks external dependencies — dependency failures must not trigger container restarts, only traffic removal.

`GET /ready` — readiness probe. Runs three dependency checks concurrently with a `CHECK_TIMEOUT_MS` timeout per check (default 3 s):
- MongoDB: `admin().command({ ping: 1 })`
- Redis: `PING` command
- Storage: `storage.ping()` (verifies upload dir or S3 bucket is accessible)

Returns `503` with per-check details if any check fails or times out. Load balancers stop routing traffic to the instance; the container is NOT restarted (that is the liveness probe's job). Per-check `latencyMs` is included in the response so operators can detect slow-but-not-failed dependencies.

### Structured logging
Every significant operation emits a Pino JSON log with a consistent field schema (`bullJobId`, `assetId`, `err`, `latencyMs`, `reqId`). In production these flow to a log aggregator (Loki, Datadog, CloudWatch) where they can be alerted on and queried. The `X-Request-Id` header is echoed back on every response so clients can correlate a failed response with the server-side log entry.

---

## 12. Folder Structure

```
src/
├── api/
│   └── v1/
│       ├── images.routes.ts     # Routes for /api/v1/images (upload, list, get, download, delete, transform)
│       ├── jobs.routes.ts       # Routes for /api/v1/jobs (status polling)
│       └── health.routes.ts     # GET /health (liveness) + GET /ready (readiness)
│
├── modules/
│   ├── images/
│   │   ├── asset.model.ts           # Mongoose schema + LeanAsset type (assets collection)
│   │   ├── asset.repository.ts      # All MongoDB queries for assets (findById, create, softDelete…)
│   │   ├── asset.schema.ts          # Zod schemas for upload/transform/list requests
│   │   ├── asset.service.ts         # getAsset, downloadAsset, deleteAsset
│   │   ├── image.controller.ts      # HTTP handlers — thin, delegates to services
│   │   ├── image-processor.ts       # Sharp pipeline (rotate → resize → grayscale → toFormat)
│   │   ├── transform-execute.service.ts  # Sync vs async decision + dedup check
│   │   └── upload.service.ts        # Upload original: size gate, format detect, hash, dedup, persist
│   └── jobs/
│       ├── job.model.ts         # Mongoose schema + LeanJob type (jobs collection)
│       ├── job.repository.ts    # All MongoDB queries for jobs (findById, create, markActive…)
│       ├── job.schema.ts        # Zod schema for :jobId path param
│       ├── job.controller.ts    # HTTP handler for GET /jobs/:jobId
│       └── job.service.ts       # getJobStatus — hydrates outputAsset on completed jobs
│
├── lib/
│   ├── logger.ts                # Pino singleton — shared by API and worker
│   ├── errors.ts                # Typed error hierarchy (AppError, NotFoundError, ValidationError…)
│   ├── error-handler.ts         # Fastify error handler — maps errors to stable response shape
│   ├── health.service.ts        # checkMongo / checkRedis / checkStorage / runReadinessChecks
│   └── transform-signature.ts   # Deterministic SHA-256 hash of normalized transform params
│
├── config/
│   └── index.ts                 # Zod-validated env — process exits on invalid config
│
├── db/
│   ├── mongoose.ts              # Mongoose connect / disconnect + event logging
│   └── indexes.ts               # Explicit index sync script — run before production deploy
│
├── queue/
│   ├── redis.ts                 # IORedis connection + isRedisReady() (shared across processes)
│   └── image.queue.ts           # BullMQ Queue instance + ImageJobPayload type
│
├── storage/
│   ├── storage.interface.ts     # StorageDriver interface: save / read / delete / exists / getUrl / ping
│   ├── local.storage.ts         # Disk implementation with path-traversal guard
│   ├── s3.storage.ts            # AWS S3 implementation (stub — see file header for guide)
│   └── index.ts                 # Factory: selects driver from STORAGE_DRIVER env
│
├── workers/
│   ├── image.worker.ts          # BullMQ Worker — wires executeTransformJob to the queue
│   └── job-processor.ts         # Full pipeline: read → process → save → update MongoDB
│
├── app.ts                       # Fastify instance: plugins, hooks, error handlers, routes
└── server.ts                    # Entry point: boot sequence, graceful shutdown, signal handling

tests/
├── api/
│   ├── upload.service.test.ts
│   ├── transform-execute.service.test.ts
│   ├── asset.service.test.ts
│   └── job.service.test.ts
├── workers/
│   └── job-processor.test.ts
└── lib/
    └── health.service.test.ts
```
