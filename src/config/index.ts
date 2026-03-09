import { z } from 'zod';

const envSchema = z.object({
  // ── App ────────────────────────────────────────────────────────────────────
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  API_VERSION: z.string().default('v1'),

  // ── MongoDB ────────────────────────────────────────────────────────────────
  MONGO_URI: z.string().url(),

  // ── Redis ──────────────────────────────────────────────────────────────────
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().int().positive().default(6379),
  REDIS_PASSWORD: z.string().optional(),

  // ── BullMQ ─────────────────────────────────────────────────────────────────
  QUEUE_NAME:        z.string().min(1).default('image-resizer'),
  QUEUE_CONCURRENCY: z.coerce.number().int().positive().default(5),
  // Total attempts per job (1 initial + N-1 retries). 3 = 1 try + 2 retries.
  QUEUE_MAX_ATTEMPTS:     z.coerce.number().int().positive().default(3),
  // Initial backoff delay in ms for exponential retry.
  // Attempt 1 → delay ms, attempt 2 → delay*2 ms, attempt 3 → delay*4 ms.
  QUEUE_BACKOFF_DELAY_MS: z.coerce.number().int().positive().default(2_000),

  // ── Storage ────────────────────────────────────────────────────────────────
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  UPLOAD_DIR: z.string().default('./uploads'),
  // Base URL for constructing publicly-accessible file URLs (local storage only).
  // For S3, URLs are derived from the bucket/CDN configuration instead.
  APP_BASE_URL: z.string().url().default('http://localhost:3000'),

  // ── AWS S3 (required when STORAGE_DRIVER=s3) ───────────────────────────────
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  AWS_REGION: z.string().optional(),
  S3_BUCKET: z.string().optional(),

  // ── Transform Decision ─────────────────────────────────────────────────────
  // Thresholds that control whether a transform runs synchronously (inline,
  // within the HTTP request) or asynchronously (offloaded to the job queue).
  // A transform routes async when ANY single threshold is exceeded.
  //
  // Tune these for your hardware profile:
  //   - Lower values push more work to the worker pool, keeping API latency
  //     predictable at the cost of added queue round-trip latency.
  //   - Higher values answer small transforms immediately at the cost of
  //     consuming API worker CPU under bursts.
  SYNC_MAX_SOURCE_BYTES:  z.coerce.number().int().positive().default(1_048_576),   // 1 MB
  SYNC_MAX_OUTPUT_PIXELS: z.coerce.number().int().positive().default(2_073_600),   // 1920 × 1080
  // Maximum number of non-resize operations (rotate, grayscale) that still
  // qualify for synchronous processing. 0 = resize-only; 1 = plus one extra op.
  SYNC_MAX_COMPLEXITY:    z.coerce.number().int().min(0).max(3).default(1),

  // ── Asset Deletion ─────────────────────────────────────────────────────────
  // When true, DELETE /v1/images/:id also immediately removes the file from
  // storage in addition to soft-deleting the MongoDB record. When false (default),
  // the file is left in storage for a background sweep to remove later, which
  // preserves the file during the soft-delete grace period and avoids any
  // unavoidable race if a concurrent worker is mid-transform on that asset.
  // z.coerce.boolean() uses Boolean() which treats the string 'false' as true.
  // Use preprocess to handle the env-var string form explicitly.
  STORAGE_DELETE_ON_ASSET_DELETE: z.preprocess(
    (val) => {
      if (typeof val === 'boolean') return val;
      if (val === 'true'  || val === '1') return true;
      if (val === 'false' || val === '0' || val === '' || val == null) return false;
      return val; // let Zod surface an error for any other value
    },
    z.boolean().default(false),
  ),

  // ── Upload Limits ──────────────────────────────────────────────────────────
  // Hard cap on uploaded file size in bytes.
  // Must be kept in sync with the @fastify/multipart fileSize limit in app.ts
  // (or lower — the multipart plugin rejects the stream first, this catches
  // anything that slips through after full buffering).
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(52_428_800), // 50 MB

  // ── Transform Dimension Limits ─────────────────────────────────────────────
  // Maximum width / height accepted by the transform endpoint.
  // Prevents callers from requesting absurdly large output canvases that
  // would consume excessive memory on the Sharp worker.
  MAX_IMAGE_WIDTH:  z.coerce.number().int().positive().default(10_000),
  MAX_IMAGE_HEIGHT: z.coerce.number().int().positive().default(10_000),

  // ── Allowed MIME Types ─────────────────────────────────────────────────────
  // Comma-separated list of MIME types accepted on upload.
  // Restricts the broader set of formats that Sharp can decode to only those
  // the operator wants to allow. Use this to block formats like image/tiff
  // or image/heif if they are not needed. Default: all Sharp-supported types.
  ALLOWED_MIME_TYPES: z
    .string()
    .default('image/jpeg,image/png,image/webp,image/avif,image/tiff,image/gif,image/heic,image/heif')
    .transform((s) => s.split(',').map((m) => m.trim()).filter(Boolean)),

  // ── Rate Limiting ──────────────────────────────────────────────────────────
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),

  // ── Logging ────────────────────────────────────────────────────────────────
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),

  // ── Shutdown ───────────────────────────────────────────────────────────────
  // How long (ms) to wait for in-flight requests before forcing process exit.
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // Use console.error here — logger is not initialised yet at config load time.
  console.error(
    '[config] Invalid environment variables:\n',
    JSON.stringify(parsed.error.flatten().fieldErrors, null, 2),
  );
  process.exit(1);
}

export const config = parsed.data;

/** Convenience flag — avoids `config.NODE_ENV === 'production'` scattered everywhere. */
export const isProd = config.NODE_ENV === 'production';
export const isDev = config.NODE_ENV === 'development';
export const isTest = config.NODE_ENV === 'test';

export type Config = typeof config;
