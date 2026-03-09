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

  // ── AWS S3 (required when STORAGE_DRIVER=s3) ───────────────────────────────
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  AWS_REGION: z.string().optional(),
  S3_BUCKET: z.string().optional(),

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
