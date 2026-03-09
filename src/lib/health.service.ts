/**
 * health.service — dependency readiness checks for the /ready probe.
 *
 * ── Design principles ─────────────────────────────────────────────────────────
 *
 * 1. Parallel  — all three checks fire concurrently via Promise.all.
 *    Individual check failures cannot cascade into each other.
 *
 * 2. Timeout-bounded  — each check is raced against CHECK_TIMEOUT_MS.
 *    A hung MongoDB server-selection call won't stall the probe past the
 *    budget the orchestrator's liveness timeout expects.
 *
 * 3. Non-throwing  — every check captures its own error and converts it to
 *    { status: 'unavailable', error }. The handler never crashes on a partial
 *    dependency failure.
 *
 * 4. Latency-tracked  — each result includes the round-trip time so operators
 *    can detect slow-but-not-failed dependencies without querying metrics.
 *
 * 5. Real roundtrips  — where possible, we issue an actual command rather than
 *    reading a cached state flag:
 *      MongoDB: admin().command({ ping: 1 }) via the live connection
 *      Redis:   PING command
 *      Storage: ping() — verifies the UPLOAD_DIR or S3 bucket is accessible
 *
 *    State flags (isDBConnected / isRedisReady) are used as fast-path guards
 *    to avoid issuing a command we know will fail and return immediately.
 *
 * ── Error message safety ──────────────────────────────────────────────────────
 *
 * Error messages are included in the response so operators can diagnose
 * without querying logs. They are sourced from `err.message`, never from
 * stack traces, and should not contain credentials (MongoDB URI is already
 * redacted in the driver; Redis password is not part of error messages).
 */

import mongoose from 'mongoose';
import { isDBConnected } from '../db/mongoose';
import { redisConnection, isRedisReady } from '../queue/redis';
import { storage } from '../storage';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CheckResult {
  /** Whether this dependency responded successfully within the timeout. */
  status: 'ok' | 'unavailable';
  /** Round-trip duration in milliseconds. */
  latencyMs: number;
  /** Human-readable error message; present only when status is 'unavailable'. */
  error?: string;
}

export interface ReadinessResult {
  ready: boolean;
  checks: {
    mongo:   CheckResult;
    redis:   CheckResult;
    storage: CheckResult;
  };
}

// ─── Configuration ────────────────────────────────────────────────────────────

/**
 * Per-check timeout. Each check is independently raced against this budget.
 * Sized to fit within a typical orchestrator probe timeout of 5–10 s while
 * leaving headroom for the HTTP round-trip.
 */
export const CHECK_TIMEOUT_MS = 3_000;

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Runs `fn()` and wraps the outcome in a CheckResult.
 * The elapsed time is measured regardless of success or failure.
 * A per-check timeout prevents a single slow dependency from blocking the
 * entire /ready response.
 */
async function timeCheck(fn: () => Promise<void>): Promise<CheckResult> {
  const start = Date.now();
  try {
    await Promise.race([
      fn(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`timed out after ${CHECK_TIMEOUT_MS} ms`)),
          CHECK_TIMEOUT_MS,
        ),
      ),
    ]);
    return { status: 'ok', latencyMs: Date.now() - start };
  } catch (err) {
    return {
      status: 'unavailable',
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─── Individual checks ────────────────────────────────────────────────────────

/**
 * Issues a MongoDB admin ping command via the active Mongoose connection.
 *
 * Fast-path: if Mongoose reports the connection is down, fail immediately
 * rather than waiting for serverSelectionTimeoutMS (5 s).
 *
 * With bufferCommands: false (set in mongoose.ts), the ping rejects at once
 * if the connection is not established instead of queuing.
 */
export async function checkMongo(): Promise<void> {
  if (!isDBConnected()) {
    throw new Error('not connected');
  }
  // db is defined when readyState === 1; the guard above ensures it.
  await mongoose.connection.db!.admin().command({ ping: 1 });
}

/**
 * Issues a Redis PING command and asserts the response is 'PONG'.
 *
 * Fast-path: if the connection is not in 'ready' state, fail immediately.
 * With maxRetriesPerRequest: null (set in redis.ts), the ping would otherwise
 * queue indefinitely — the per-check timeout is the safety net, but the
 * state guard avoids issuing the command at all when obviously disconnected.
 */
export async function checkRedis(): Promise<void> {
  if (!isRedisReady()) {
    throw new Error('not connected');
  }
  const response = await redisConnection.ping();
  if (response !== 'PONG') {
    throw new Error(`unexpected PING response: ${response}`);
  }
}

/**
 * Calls storage.ping() to verify the backend is accessible.
 *
 * For local storage: asserts UPLOAD_DIR is readable + writable.
 * For S3 storage:    issues a lightweight bucket reachability check.
 */
export async function checkStorage(): Promise<void> {
  await storage.ping();
}

// ─── Readiness aggregation ────────────────────────────────────────────────────

/**
 * Runs all three dependency checks in parallel and aggregates the results.
 *
 * Safe to call on every probe request — checks are lightweight and the
 * timeout bounds worst-case duration to CHECK_TIMEOUT_MS regardless of
 * dependency responsiveness.
 */
export async function runReadinessChecks(): Promise<ReadinessResult> {
  const [mongo, redis, storageCheck] = await Promise.all([
    timeCheck(checkMongo),
    timeCheck(checkRedis),
    timeCheck(checkStorage),
  ]);

  const ready =
    mongo.status === 'ok' &&
    redis.status === 'ok' &&
    storageCheck.status === 'ok';

  return {
    ready,
    checks: { mongo, redis, storage: storageCheck },
  };
}
