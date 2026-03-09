/**
 * Image transform queue — producer and lifecycle management.
 *
 * This module owns the BullMQ Queue instance for the API process.
 * It exposes:
 *
 *   enqueueTransformJob  — add a typed job to the queue, return the BullMQ ID
 *   closeImageQueue      — drain in-flight enqueues and close the connection
 *
 * What this module does NOT do:
 *   - Create or update MongoDB Job / Asset records (caller's responsibility)
 *   - Process jobs (handled by src/workers/image.worker.ts)
 *   - Connect this to HTTP routes (wired in a future service layer)
 *
 * ── Ordering guarantee ────────────────────────────────────────────────────────
 *
 * The caller must create the MongoDB Job record BEFORE calling
 * `enqueueTransformJob`. This ordering ensures the BullMQ job ID can be
 * stored in Mongo (via `job.bullJobId`) immediately after enqueueing, and
 * prevents the worker from receiving a job whose Mongo document does not yet
 * exist (which would cause a lookup failure on the first status update).
 *
 *   Recommended call sequence:
 *     1. createJob(...)         → MongoDB Job document, status: 'queued'
 *     2. enqueueTransformJob(…) → BullMQ Job, returns bullJobId
 *
 * If step 2 fails after step 1, the MongoDB job stays in 'queued' but has no
 * corresponding BullMQ entry — a background reconciliation sweep (future work)
 * can detect and re-enqueue orphaned queued jobs.
 */

import { Queue, type ConnectionOptions } from 'bullmq';
import type { Types } from 'mongoose';
import { bullMQConnectionOptions } from './redis';
import { QUEUE_NAME, JOB_NAMES, buildDefaultJobOptions } from './queue.config';
import type { ImageJobPayload, TransformJobPayload } from './job-payload.types';
import { logger } from '../lib/logger';

// Re-export payload types so callers can import everything from one place.
export type { ImageJobPayload, TransformJobPayload } from './job-payload.types';

// ─── Queue instance ───────────────────────────────────────────────────────────

/**
 * The singleton BullMQ Queue instance for the API process.
 *
 * Not exported directly — all interaction goes through the typed producer
 * functions below. This keeps the queue implementation swappable (e.g., from
 * BullMQ to SQS) without changing call sites.
 *
 * The `as ConnectionOptions` cast is required because BullMQ's bundled ioredis
 * and the top-level ioredis package are nominally different types. Passing a
 * plain options object (not a Redis instance) avoids the structural mismatch.
 * See queue/redis.ts for the full explanation.
 */
const imageQueue = new Queue<ImageJobPayload>(QUEUE_NAME, {
  connection: bullMQConnectionOptions as ConnectionOptions,
  defaultJobOptions: buildDefaultJobOptions(),
});

// Log queue-level errors so they appear in structured logs rather than
// propagating as unhandled EventEmitter errors (which would crash the process).
imageQueue.on('error', (err: Error) => {
  logger.error({ err, queue: QUEUE_NAME }, 'BullMQ queue error');
});

// ─── Producer ─────────────────────────────────────────────────────────────────

export interface EnqueueInput {
  /** Determines which transform path the worker takes and the BullMQ job name. */
  jobType: 'resize' | 'convert' | 'thumbnail';

  /** MongoDB Job document _id — the worker uses this to update job status. */
  mongoJobId: string | Types.ObjectId;

  /** MongoDB Asset _id for the source (original) image. */
  sourceAssetId: string | Types.ObjectId;

  /**
   * Storage key for the source image.
   * The worker reads the source bytes via `storage.read(sourceStorageKey)`.
   * Passing this avoids an extra DB roundtrip inside the worker.
   */
  sourceStorageKey: string;

  /** MongoDB Asset _id for the output (derived) image to create/update. */
  outputAssetId: string | Types.ObjectId;

  /** The fully-resolved transform parameters to apply. */
  transform: TransformJobPayload;

  /**
   * Maximum number of attempts for this specific job.
   * Overrides QUEUE_MAX_ATTEMPTS for jobs that warrant different retry budgets
   * (e.g., fewer retries for thumbnail jobs, more for high-value resize jobs).
   * Omit to use the QUEUE_MAX_ATTEMPTS env default.
   */
  maxAttempts?: number;
}

export interface EnqueueResult {
  /** The BullMQ-assigned job ID, stored in Redis. Save this in the MongoDB Job
   *  document's `bullJobId` field so the worker can cross-reference the records. */
  bullJobId: string;
}

/**
 * Adds a typed image transform job to the BullMQ queue.
 *
 * Returns the BullMQ job ID that the caller must persist in the MongoDB Job
 * document so the worker can look up and update the correct record.
 *
 * @throws If BullMQ fails to add the job (Redis unreachable, serialisation error).
 *         The caller should handle this and roll back the MongoDB Job record
 *         or leave it in 'queued' for the reconciliation sweep.
 */
export async function enqueueTransformJob(input: EnqueueInput): Promise<EnqueueResult> {
  const payload: ImageJobPayload = {
    jobType:          input.jobType,
    mongoJobId:       input.mongoJobId.toString(),
    sourceAssetId:    input.sourceAssetId.toString(),
    sourceStorageKey: input.sourceStorageKey,
    outputAssetId:    input.outputAssetId.toString(),
    transform:        input.transform,
  };

  const jobName    = JOB_NAMES[input.jobType];
  const jobOptions = buildDefaultJobOptions(input.maxAttempts);

  const job = await imageQueue.add(jobName, payload, jobOptions);

  // BullMQ always assigns an ID on a successful add(). Guard defensively —
  // a missing ID indicates an unexpected BullMQ version incompatibility.
  if (!job.id) {
    throw new Error(
      `BullMQ returned a job without an ID (queue=${QUEUE_NAME}, name=${jobName}). ` +
      `This should never happen — check BullMQ version compatibility.`,
    );
  }

  logger.info(
    {
      bullJobId:        job.id,
      jobName,
      jobType:          input.jobType,
      mongoJobId:       input.mongoJobId.toString(),
      sourceAssetId:    input.sourceAssetId.toString(),
      outputAssetId:    input.outputAssetId.toString(),
    },
    'Transform job enqueued',
  );

  return { bullJobId: job.id };
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

/**
 * Closes the queue connection gracefully.
 *
 * Call this during API process shutdown AFTER the HTTP server has stopped
 * accepting requests (so no new enqueue calls can arrive) and BEFORE closing
 * the Redis connection. This allows any in-flight `queue.add()` calls that
 * were triggered by the last batch of HTTP requests to complete before the
 * Redis connection drops.
 *
 * Shutdown sequence in server.ts:
 *   1. app.close()          — drain HTTP requests
 *   2. closeImageQueue()    — this function
 *   3. disconnectDB()       — MongoDB
 *   4. redisConnection.quit() — Redis
 */
export async function closeImageQueue(): Promise<void> {
  await imageQueue.close();
  logger.info({ queue: QUEUE_NAME }, 'Image queue closed');
}
