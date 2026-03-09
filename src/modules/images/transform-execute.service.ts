/**
 * transform-execute.service — full transform orchestration.
 *
 * This service owns the end-to-end flow for a transform request:
 *
 *   1. Load source asset — validate it exists, is original, and is ready.
 *   2. Resolve transform — dedup check (findOrCreateDerivedAsset) and
 *      execution-mode decision (sync vs async).
 *   3a. If duplicate   — return the existing derived asset immediately.
 *   3b. If sync        — run the Sharp pipeline inline and return the result.
 *   3c. If async       — enqueue a BullMQ job and create the MongoDB Job
 *                        record; return the pending asset + job metadata.
 *
 * ── Sync vs async split ───────────────────────────────────────────────────────
 *
 * Sync and async share the same dedup logic and produce the same derived asset
 * record structure. The difference is who executes the transform:
 *
 *   Sync  — this service runs Sharp inline, within the HTTP request lifecycle.
 *            The response carries the completed derived asset (status: 'ready').
 *
 *   Async — this service enqueues a BullMQ job and returns immediately.
 *            The response carries the pending asset (status: 'pending') plus
 *            the job ID / status URL so the client can poll for completion.
 *
 * ── Async enqueue ordering ────────────────────────────────────────────────────
 *
 * BullMQ is enqueued before the MongoDB Job document is created. If the MongoDB
 * insert fails after a successful enqueue, the worker handles the missing-record
 * case gracefully (markJobActive logs a warning and continues — the image is
 * still transformed and the derived asset is updated to 'ready'). A future
 * reconciliation sweep can detect and clean up orphaned BullMQ jobs.
 */

import crypto from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { Types } from 'mongoose';
import { storage, derivedKey } from '../../storage';
import { processImage } from '../../lib/image-processor';
import { computeTransformSignature } from '../../lib/transform-signature';
import { config } from '../../config';
import { findAssetById, updateAssetStatus } from './asset.repository';
import { resolveTransform } from './transform.service';
import { createJob } from '../jobs/job.repository';
import { enqueueTransformJob } from '../../queue/image.queue';
import { NotFoundError, BadRequestError } from '../../lib/errors';
import type { LeanAsset, IAssetFile, IAssetStorage, IAssetTransform } from './asset.model';
import type { LeanJob } from '../jobs/job.model';
import type { TransformParamsOutput } from './asset.schema';

// ─── Return Types ─────────────────────────────────────────────────────────────

export interface TransformDeduplicated {
  mode: 'deduplicated';
  /** The existing derived asset — may be pending, processing, ready, or failed. */
  asset: LeanAsset;
}

export interface TransformSynced {
  mode: 'sync';
  /** The completed derived asset (status: 'ready'). */
  asset: LeanAsset;
}

export interface TransformQueued {
  mode: 'async';
  /** The pending derived asset (status: 'pending'). */
  asset: LeanAsset;
  /** The MongoDB Job document created for this transform. */
  job: LeanJob;
}

/** Narrow with `switch (result.mode)`. */
export type TransformExecuteResult = TransformDeduplicated | TransformSynced | TransformQueued;

// ─── Service ──────────────────────────────────────────────────────────────────

/**
 * Executes the full transform request lifecycle.
 *
 * @param sourceAssetId  Hex ObjectId string of the original (source) asset.
 * @param transform      Validated, resolved transform parameters.
 * @param log            Request-scoped logger.
 *
 * @throws NotFoundError    If the source asset does not exist.
 * @throws BadRequestError  If the source asset is not an 'original' in 'ready' state.
 */
export async function executeTransformRequest(
  sourceAssetId: string,
  transform: TransformParamsOutput,
  log: FastifyBaseLogger,
): Promise<TransformExecuteResult> {
  // ── Step 1: load and validate source asset ────────────────────────────────
  const sourceAsset = await findAssetById(sourceAssetId);

  if (!sourceAsset) {
    throw new NotFoundError('Asset');
  }
  if (sourceAsset.type !== 'original') {
    throw new BadRequestError('Only original assets can be transformed');
  }
  if (sourceAsset.status !== 'ready' || !sourceAsset.file || !sourceAsset.storage) {
    throw new BadRequestError('Source asset is not ready for transformation');
  }

  // Narrowed after the guard above — file and storage are guaranteed present.
  const readySource = sourceAsset as LeanAsset & { file: IAssetFile; storage: IAssetStorage };

  const assetTransform: IAssetTransform = {
    width:     transform.width,
    height:    transform.height,
    format:    transform.format,
    quality:   transform.quality,
    fit:       transform.fit,
    rotate:    transform.rotate,
    grayscale: transform.grayscale,
  };

  // ── Step 2: dedup check + execution-mode decision ─────────────────────────
  const resolveResult = await resolveTransform(
    {
      sourceAssetId:   readySource._id,
      sourceSizeBytes: readySource.file.sizeBytes,
      transform:       assetTransform,
    },
    log,
  );

  if (resolveResult.isDuplicate) {
    return { mode: 'deduplicated', asset: resolveResult.asset };
  }

  const { asset: derivedAsset, executionMode } = resolveResult;

  // ── Step 3a: sync — run Sharp inline ─────────────────────────────────────
  if (executionMode === 'sync') {
    log.info(
      { sourceAssetId, assetId: derivedAsset._id.toString() },
      'Executing transform synchronously',
    );
    const finalAsset = await processSyncTransform(derivedAsset, readySource, log);
    return { mode: 'sync', asset: finalAsset };
  }

  // ── Step 3b: async — enqueue + create job record ─────────────────────────
  log.info(
    { sourceAssetId, assetId: derivedAsset._id.toString() },
    'Dispatching transform to async queue',
  );
  const job = await dispatchAsyncTransform(derivedAsset, readySource);
  return { mode: 'async', asset: derivedAsset, job };
}

// ─── Sync helper ──────────────────────────────────────────────────────────────

/**
 * Runs the Sharp transform pipeline inline (no job queue) and updates the
 * derived asset to 'ready' when done.
 *
 * Uses the same processing steps as job-processor.ts (executeTransformJob)
 * so the output is byte-identical whether the transform runs sync or async.
 */
async function processSyncTransform(
  derivedAsset: LeanAsset,
  sourceAsset: LeanAsset & { file: IAssetFile; storage: IAssetStorage },
  log: FastifyBaseLogger,
): Promise<LeanAsset> {
  const outputObjectId = derivedAsset._id;
  const transform = derivedAsset.transform!;

  await updateAssetStatus(outputObjectId, 'processing');

  const sourceBuffer = await storage.read(sourceAsset.storage.key);
  const result = await processImage(sourceBuffer, transform);

  const transformSig = computeTransformSignature({
    width:     transform.width,
    height:    transform.height,
    format:    transform.format,
    quality:   transform.quality,
    fit:       transform.fit,
    rotate:    transform.rotate,
    grayscale: transform.grayscale,
  });

  const outputKey = derivedKey(sourceAsset._id.toString(), transformSig, transform.format);
  await storage.save(result.buffer, outputKey);
  const url = storage.getUrl(outputKey);

  const hash = crypto.createHash('sha256').update(result.buffer).digest('hex');

  const finalAsset = await updateAssetStatus(outputObjectId, 'ready', {
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

  log.info(
    { assetId: outputObjectId.toString(), outputKey, sizeBytes: result.sizeBytes },
    'Synchronous transform completed',
  );

  // updateAssetStatus returns null only if the document was deleted between
  // the findOrCreate and the update — guard defensively.
  if (!finalAsset) {
    throw new Error(
      `Derived asset disappeared during sync transform: id=${outputObjectId.toString()}`,
    );
  }

  return finalAsset;
}

// ─── Async helper ─────────────────────────────────────────────────────────────

/**
 * Enqueues a BullMQ job and creates the corresponding MongoDB Job document.
 *
 * Enqueue happens first: if the MongoDB insert fails after a successful
 * enqueue, the worker continues anyway (markJobActive handles missing records
 * gracefully). If enqueue fails, the MongoDB insert is never attempted.
 */
async function dispatchAsyncTransform(
  derivedAsset: LeanAsset,
  sourceAsset: LeanAsset & { file: IAssetFile; storage: IAssetStorage },
): Promise<LeanJob> {
  const transform = derivedAsset.transform!;

  const { bullJobId } = await enqueueTransformJob({
    jobType:          'resize',
    // mongoJobId is stored in the BullMQ payload as reference metadata.
    // The worker uses bullJobId for all actual lookups — see job.repository.ts.
    mongoJobId:       new Types.ObjectId().toHexString(),
    sourceAssetId:    sourceAsset._id,
    sourceStorageKey: sourceAsset.storage.key,
    outputAssetId:    derivedAsset._id,
    transform: {
      width:     transform.width,
      height:    transform.height,
      format:    transform.format,
      quality:   transform.quality,
      fit:       transform.fit,
      rotate:    transform.rotate,
      grayscale: transform.grayscale,
    },
  });

  return createJob({
    type:          'resize',
    bullJobId,
    inputAssetId:  sourceAsset._id,
    outputAssetId: derivedAsset._id,
    payload: {
      type:      'resize',
      width:     transform.width,
      height:    transform.height,
      format:    transform.format,
      quality:   transform.quality,
      fit:       transform.fit,
      rotate:    transform.rotate,
      grayscale: transform.grayscale,
    },
    maxAttempts: config.QUEUE_MAX_ATTEMPTS,
  });
}
