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
  QUEUE_NAME: z.string().min(1).default('image-resize'),
  QUEUE_CONCURRENCY: z.coerce.number().int().positive().default(5),

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
