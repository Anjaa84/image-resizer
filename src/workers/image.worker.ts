/**
 * Image transform worker — runs as a separate long-lived process.
 *
 * Lifecycle:
 *   1. Connect to MongoDB (needed for job/asset status updates)
 *   2. Create the BullMQ Worker — begins polling the queue immediately
 *   3. Register SIGTERM / SIGINT handlers for graceful shutdown
 *
 * This file is intentionally a shell. The job processor function body
 * (the Sharp transform pipeline, storage writes, and DB updates) will be
 * implemented in the next phase. The structure, error handling, event
 * listeners, and shutdown logic are production-ready now so that adding
 * processor logic is a focused, low-risk change.
 *
 * ── Process separation ────────────────────────────────────────────────────────
 *
 * The worker runs in a separate OS process from the API server. This means:
 *   - CPU-intensive Sharp transforms do not block the API event loop
 *   - Workers can be scaled independently of API replicas
 *   - A crashed worker does not take down the API (and vice versa)
 *   - The worker can be restarted without interrupting HTTP traffic
 *
 * ── Graceful shutdown ─────────────────────────────────────────────────────────
 *
 * On SIGTERM (container stop, orchestrator scale-down):
 *   1. Stop accepting new jobs from the queue
 *   2. Wait for any currently-processing job to finish (or timeout)
 *   3. Disconnect from MongoDB
 *   4. Exit cleanly
 *
 * BullMQ's worker.close() implements step 2: it signals the worker to stop
 * after the current job finishes, then resolves. Jobs that were in-flight
 * when the worker shuts down are re-queued by BullMQ automatically (they
 * remain locked in Redis until the lock expires, after which another worker
 * picks them up).
 */

import { Worker, type Job } from 'bullmq';
import { config } from '../config';
import { bullMQConnectionOptions } from '../queue/redis';
import { QUEUE_NAME } from '../queue/queue.config';
import { logger } from '../lib/logger';
import { connectDB, disconnectDB } from '../db/mongoose';
import type { ImageJobPayload } from '../queue/job-payload.types';
import { executeTransformJob, handleFinalJobFailure } from './job-processor';

// ─── Processor ────────────────────────────────────────────────────────────────

/**
 * Job processor — called by BullMQ for each dequeued job.
 *
 * Stub: the transform logic will be implemented in the next phase.
 * The function signature and error-throwing pattern are intentional:
 *   - BullMQ catches any thrown error and marks the job as failed
 *   - If `attempts < maxAttempts`, BullMQ re-queues with exponential backoff
 *   - If `attempts === maxAttempts`, the job moves to the failed state
 *
 * The processor receives a fully-typed `Job<ImageJobPayload>` so TypeScript
 * enforces that `job.data` has the correct shape at compile time.
 */
async function processJob(job: Job<ImageJobPayload>): Promise<void> {
  const { jobType, mongoJobId, sourceAssetId, outputAssetId } = job.data;

  logger.info(
    {
      bullJobId:    job.id,
      attempt:      job.attemptsMade + 1,
      maxAttempts:  job.opts.attempts,
      jobType,
      mongoJobId,
      sourceAssetId,
      outputAssetId,
    },
    'Processing transform job',
  );

  await executeTransformJob(job.data, job.id!);
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

async function bootstrap(): Promise<void> {
  logger.info(
    {
      queue:       QUEUE_NAME,
      concurrency: config.QUEUE_CONCURRENCY,
      maxAttempts: config.QUEUE_MAX_ATTEMPTS,
    },
    'Starting image transform worker',
  );

  await connectDB();

  const worker = new Worker<ImageJobPayload>(
    QUEUE_NAME,
    processJob,
    {
      connection:  bullMQConnectionOptions,
      concurrency: config.QUEUE_CONCURRENCY,
      // Run up to concurrency jobs in parallel. Each job is a separate async
      // call to processJob, so Sharp can process multiple images concurrently.
      // Tune QUEUE_CONCURRENCY to match available CPU cores on the worker host.
    },
  );

  // ── Worker event handlers ─────────────────────────────────────────────────

  worker.on('active', (job: Job<ImageJobPayload>) => {
    logger.info(
      { bullJobId: job.id, jobType: job.data.jobType, attempt: job.attemptsMade + 1 },
      'Job started',
    );
  });

  worker.on('completed', (job: Job<ImageJobPayload>) => {
    logger.info(
      { bullJobId: job.id, jobType: job.data.jobType, outputAssetId: job.data.outputAssetId },
      'Job completed',
    );
  });

  worker.on('failed', (job: Job<ImageJobPayload> | undefined, err: Error) => {
    logger.error(
      {
        bullJobId:   job?.id,
        jobType:     job?.data.jobType,
        attempt:     job?.attemptsMade,
        maxAttempts: job?.opts.attempts,
        err,
      },
      'Job failed',
    );

    // Persist final failure state ONLY when all retry attempts are exhausted.
    // Calling this on intermediate failures would permanently mark the asset
    // as 'failed' while BullMQ still intends to retry.
    if (job) {
      const maxAttempts = job.opts.attempts ?? config.QUEUE_MAX_ATTEMPTS;
      const isFinalAttempt = job.attemptsMade >= maxAttempts;
      if (isFinalAttempt) {
        void handleFinalJobFailure(job.id!, job.data.outputAssetId, err.message).catch(
          (innerErr: unknown) =>
            logger.error({ innerErr, bullJobId: job.id }, 'Error persisting final failure state'),
        );
      }
    }
  });

  worker.on('error', (err: Error) => {
    // Worker-level error (connection drop, serialisation error) — distinct from
    // a job-level failure. Does not terminate the worker; BullMQ reconnects.
    logger.error({ err, queue: QUEUE_NAME }, 'Worker error');
  });

  worker.on('stalled', (jobId: string) => {
    // A stalled job is one whose lock expired before the processor finished.
    // BullMQ re-queues it automatically. Log for alerting — frequent stalls
    // indicate the job takes longer than the lock duration.
    logger.warn({ bullJobId: jobId }, 'Job stalled — lock expired, will be re-queued');
  });

  logger.info({ queue: QUEUE_NAME, concurrency: config.QUEUE_CONCURRENCY }, 'Worker ready');

  // ── Graceful shutdown ─────────────────────────────────────────────────────

  let isShuttingDown = false;

  async function shutdown(signal: string): Promise<void> {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logger.info({ signal }, 'Shutdown signal received — draining worker');

    // Force-exit timer: if the graceful shutdown takes longer than
    // SHUTDOWN_TIMEOUT_MS (e.g., a stuck job that never resolves), exit
    // forcefully so the orchestrator can restart the process.
    const forceExitTimer = setTimeout(() => {
      logger.fatal(
        { timeoutMs: config.SHUTDOWN_TIMEOUT_MS },
        'Worker graceful shutdown timed out — forcing exit',
      );
      process.exit(1);
    }, config.SHUTDOWN_TIMEOUT_MS);

    forceExitTimer.unref();

    try {
      // worker.close() stops accepting new jobs and waits for the currently
      // processing job to finish before resolving. This ensures the in-flight
      // job completes cleanly rather than being re-queued as stalled.
      await worker.close();
      logger.info('Worker closed — no more jobs will be processed');

      await disconnectDB();
      logger.info('MongoDB connection closed');

      clearTimeout(forceExitTimer);
      logger.info('Worker shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.fatal({ err }, 'Error during worker shutdown — forcing exit');
      process.exit(1);
    }
  }

  // .once() — additional signals during shutdown are ignored (the isShuttingDown
  // guard handles the case where a different signal arrives mid-shutdown).
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT',  () => void shutdown('SIGINT'));
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

bootstrap().catch((err: unknown) => {
  logger.fatal({ err }, 'Worker failed to start');
  process.exit(1);
});
