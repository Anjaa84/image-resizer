/**
 * job-processor — the core transform execution logic, decoupled from BullMQ.
 *
 * Extracting this from image.worker.ts serves two purposes:
 *   1. Testability — unit tests exercise this function directly with mocked
 *      I/O dependencies, without needing a running BullMQ instance.
 *   2. Clarity — the worker shell (bootstrap, lifecycle, event handlers) is
 *      kept clean. Every line here is about the transform pipeline itself.
 *
 * ── Processing pipeline ───────────────────────────────────────────────────────
 *
 *   1. markJobActive        — transition queued/active → active, increment attempts
 *   2. updateAssetStatus    — derived asset pending → processing
 *   3. storage.read         — fetch source image bytes from storage
 *   4. processImage         — run Sharp transform pipeline
 *   5. computeTransformSignature + derivedKey — compute the output storage key
 *   6. storage.save         — persist the transformed image bytes
 *   7. updateAssetStatus    — derived asset processing → ready (with file metadata)
 *   8. markJobCompleted     — record completion in MongoDB Job document
 *
 * ── Retry safety ─────────────────────────────────────────────────────────────
 *
 * Every step is safe to retry from the beginning:
 *
 *   Steps 1–2  — repository upserts using $set; idempotent on repeat.
 *   Step 3     — read-only; idempotent by definition.
 *   Step 4     — stateless Sharp transform; same input → same output.
 *   Steps 5–6  — derivedKey is deterministic (content-addressed); a second
 *                save to the same key overwrites the first identically.
 *   Steps 7–8  — $set updates; idempotent on repeat.
 *
 * If `executeTransformJob` throws at any point, BullMQ will re-queue the job
 * with exponential backoff (up to maxAttempts). The next attempt starts over
 * from step 1, which is safe because all steps are idempotent.
 *
 * ── Failure path ─────────────────────────────────────────────────────────────
 *
 * `handleFinalJobFailure` is called by the worker's `failed` event handler
 * ONLY when all retry attempts are exhausted. It must NOT be called on
 * intermediate failures — doing so would mark the asset 'failed' while BullMQ
 * still intends to retry, leaving the asset in a permanently incorrect state.
 */

import crypto from 'node:crypto';
import { Types } from 'mongoose';
import { storage, derivedKey } from '../storage';
import { processImage } from '../lib/image-processor';
import { computeTransformSignature } from '../lib/transform-signature';
import { config } from '../config';
import { logger } from '../lib/logger';
import { markJobActive, markJobCompleted, markJobFailed } from '../modules/jobs/job.repository';
import { updateAssetStatus } from '../modules/images/asset.repository';
import type { ImageJobPayload } from '../queue/job-payload.types';
import type { TransformOptions } from '../lib/transform-options';

// ─── Happy path ───────────────────────────────────────────────────────────────

/**
 * Executes the full image transform pipeline for a single BullMQ job.
 *
 * @param payload    The typed job data from BullMQ (stored in Redis).
 * @param bullJobId  The BullMQ job ID, used for repository status updates.
 *
 * @throws Any error from storage, Sharp, or the repository layer. BullMQ
 *         catches the thrown error and handles retry/failure bookkeeping.
 *         Do NOT swallow errors here — re-throw them so BullMQ can retry.
 */
export async function executeTransformJob(
  payload: ImageJobPayload,
  bullJobId: string,
): Promise<void> {
  const { sourceStorageKey, outputAssetId, sourceAssetId, transform } = payload;
  const outputObjectId = new Types.ObjectId(outputAssetId);

  // ── Step 1: mark job active ──────────────────────────────────────────────
  // Atomic: increments attempt counter, sets startedAt only on the first attempt.
  const activeJob = await markJobActive(bullJobId);
  if (!activeJob) {
    // The MongoDB Job record is missing. This is an anomalous state (the BullMQ
    // job exists but the DB record does not). Log a warning and continue — the
    // image transform is more important than DB bookkeeping, and the transform
    // result will still be persisted if subsequent steps succeed.
    logger.warn(
      { bullJobId, outputAssetId },
      'MongoDB Job record not found when marking active — continuing anyway',
    );
  }

  // ── Step 2: mark derived asset as processing ─────────────────────────────
  await updateAssetStatus(outputObjectId, 'processing');

  logger.info(
    { bullJobId, jobType: payload.jobType, sourceAssetId, outputAssetId },
    'Transform pipeline started',
  );

  // ── Step 3: read source image from storage ───────────────────────────────
  const sourceBuffer = await storage.read(sourceStorageKey);

  // ── Step 4: run Sharp transform pipeline ─────────────────────────────────
  // TransformJobPayload and TransformOptions are structurally identical.
  // Cast explicitly to satisfy TypeScript without runtime overhead.
  const transformOptions: TransformOptions = {
    width:     transform.width,
    height:    transform.height,
    format:    transform.format,
    quality:   transform.quality,
    fit:       transform.fit,
    rotate:    transform.rotate,
    grayscale: transform.grayscale,
  };

  const result = await processImage(sourceBuffer, transformOptions);

  // ── Step 5: compute output storage key ───────────────────────────────────
  // The transform signature is a deterministic hash of the canonical params.
  // The derived key namespaces under the source asset ID so all variants of
  // an original can be listed / deleted by prefix.
  const transformSignature = computeTransformSignature({
    width:     transform.width,
    height:    transform.height,
    format:    transform.format,
    quality:   transform.quality,
    fit:       transform.fit,
    rotate:    transform.rotate,
    grayscale: transform.grayscale,
  });

  const outputKey = derivedKey(sourceAssetId, transformSignature, transform.format);

  // ── Step 6: save transformed bytes to storage ────────────────────────────
  await storage.save(result.buffer, outputKey);
  const url = storage.getUrl(outputKey);

  logger.info(
    { bullJobId, outputKey, sizeBytes: result.sizeBytes, width: result.width, height: result.height },
    'Transformed image saved to storage',
  );

  // ── Step 7: compute content hash, update derived asset → ready ───────────
  // Content hash of the actual derived image bytes — ensures the asset record
  // carries a correct hash regardless of the input (different sources with
  // different transforms may coincidentally produce the same bytes, though
  // this is astronomically unlikely for photographic images).
  const hash = crypto.createHash('sha256').update(result.buffer).digest('hex');

  await updateAssetStatus(outputObjectId, 'ready', {
    file: {
      originalName: `derived-${transform.width}x${transform.height}.${transform.format}`,
      mimeType:     result.mimeType,
      sizeBytes:    result.sizeBytes,
      hash,
      width:        result.width,
      height:       result.height,
    },
    storage: {
      driver: config.STORAGE_DRIVER,
      bucket: config.STORAGE_DRIVER === 's3' ? config.S3_BUCKET : undefined,
      key:    outputKey,
      url,
    },
  });

  // ── Step 8: mark job completed in MongoDB ────────────────────────────────
  await markJobCompleted(bullJobId, outputObjectId);

  logger.info(
    { bullJobId, outputAssetId, url },
    'Transform job completed successfully',
  );
}

// ─── Failure path ─────────────────────────────────────────────────────────────

/**
 * Persists the final-failure state to MongoDB when all BullMQ retry attempts
 * are exhausted.
 *
 * Must be called ONLY when all retries are exhausted (i.e., from the worker's
 * `failed` event handler, checked against `job.attemptsMade >= job.opts.attempts`).
 * Calling this on intermediate failures would permanently mark the asset as
 * 'failed' while BullMQ still intends to retry it.
 *
 * @param bullJobId      The BullMQ job ID.
 * @param outputAssetId  The derived asset MongoDB _id (hex string).
 * @param errorMessage   The error message from the last failed attempt.
 */
export async function handleFinalJobFailure(
  bullJobId:      string,
  outputAssetId:  string,
  errorMessage:   string,
): Promise<void> {
  const outputObjectId = new Types.ObjectId(outputAssetId);

  // Run both updates concurrently — they are independent operations.
  await Promise.all([
    markJobFailed(bullJobId, errorMessage),
    updateAssetStatus(outputObjectId, 'failed'),
  ]);

  logger.error(
    { bullJobId, outputAssetId, errorMessage },
    'Transform job permanently failed — all retry attempts exhausted',
  );
}
