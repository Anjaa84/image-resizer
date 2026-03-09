/**
 * Queue configuration — naming conventions, retry strategy, and default job options.
 *
 * This module contains only constants and pure functions. It has no side effects
 * and creates no connections, so it can be imported anywhere (including tests)
 * without triggering Redis I/O.
 *
 * ── Naming convention ─────────────────────────────────────────────────────────
 *
 *   Queue name  : image-resizer          (one logical queue for all transform types)
 *   Job names   : transform:<type>       (namespaced for dashboard filtering)
 *
 * A single queue keeps the worker pool unified — any worker can pick any
 * transform type. Job names within the queue provide observability and
 * allow targeted dashboards without requiring separate queues per type.
 *
 * The queue name is sourced from QUEUE_NAME env var (default: 'image-resizer')
 * so it can differ per environment to prevent cross-environment job leakage
 * when multiple environments share a Redis instance.
 *
 * ── Retry strategy ────────────────────────────────────────────────────────────
 *
 *   Strategy    : Exponential backoff
 *   Formula     : delay × 2^(attemptsMade)
 *   Default     : 2 000 ms initial delay
 *
 *   Attempt 1 (initial)  → processed immediately
 *   Attempt 2 (retry 1)  → waits 2 000 ms
 *   Attempt 3 (retry 2)  → waits 4 000 ms
 *   Attempt 4 (retry 3)  → waits 8 000 ms  [if maxAttempts=4]
 *
 * Exponential backoff prevents thundering-herd retries when the worker fleet
 * recovers from a downstream failure (e.g., storage temporarily unavailable).
 *
 * ── Retention policy ──────────────────────────────────────────────────────────
 *
 *   removeOnComplete: { count: 100 }
 *     Keep the last 100 completed jobs in Redis for short-term observability
 *     (BullMQ dashboards, recent job inspection). Without a cap this grows
 *     unboundedly and consumes increasing Redis memory.
 *
 *   removeOnFail: { count: 500 }
 *     Keep more failed jobs because they require manual inspection and
 *     potential re-queueing. 500 is generous but still bounded.
 */

import type { JobsOptions } from 'bullmq';
import { config } from '../config';

// ─── Queue name ────────────────────────────────────────────────────────────────

/**
 * The single BullMQ queue name shared by all API instances and worker processes.
 * All three must use the same name to share a logical Redis queue.
 */
export const QUEUE_NAME: string = config.QUEUE_NAME;

// ─── Job names ─────────────────────────────────────────────────────────────────

/**
 * BullMQ job names within the queue.
 *
 * Using namespaced job names (`transform:<type>`) makes each transform type
 * distinguishable in BullMQ dashboards and Bull Board UIs without requiring
 * separate queues. The worker processes all names from a single queue.
 *
 * If a future requirement calls for per-type worker pools (e.g., AVIF jobs
 * routed to GPU-equipped workers), this can be promoted to separate queues
 * by changing the value here — the producer/consumer call sites stay the same.
 */
export const JOB_NAMES = {
  resize:    'transform:resize',
  convert:   'transform:convert',
  thumbnail: 'transform:thumbnail',
} as const;

export type JobName = (typeof JOB_NAMES)[keyof typeof JOB_NAMES];

// ─── Default job options ──────────────────────────────────────────────────────

/**
 * Builds default BullMQ job options with the configured retry strategy.
 *
 * This is a function (not a constant) so that calling code always gets the
 * live values from `config` — useful if config is mocked in tests and the
 * default needs to change per test run.
 *
 * @param maxAttempts  Override the default attempt count for a specific job.
 *                     Useful when enqueuing low-priority jobs with fewer
 *                     retries or high-value jobs with more.
 */
export function buildDefaultJobOptions(
  maxAttempts: number = config.QUEUE_MAX_ATTEMPTS,
): JobsOptions {
  return {
    attempts: maxAttempts,

    backoff: {
      type:  'exponential',
      // Initial delay before the first retry. Subsequent retries double:
      // retry 1 → delay, retry 2 → delay×2, retry 3 → delay×4, …
      delay: config.QUEUE_BACKOFF_DELAY_MS,
    },

    // Bounded retention — prevents unbounded Redis memory growth.
    removeOnComplete: { count: 100 },
    removeOnFail:     { count: 500 },
  };
}
