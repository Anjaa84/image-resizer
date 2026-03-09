/**
 * transform.service — deduplication lookup and execution-mode orchestration.
 *
 * This is the single entry point for the "should we process this transform?"
 * question. It answers two sub-questions in sequence:
 *
 *   1. Deduplication — has this exact transform already been applied to this
 *      source asset? If yes, return the existing derived asset immediately.
 *      The caller never needs to enqueue or run the processor.
 *
 *   2. Decision — for a new (non-duplicate) transform, should it run
 *      synchronously (inline, within the HTTP handler) or asynchronously
 *      (via the job queue)? This is delegated to `decideExecutionMode`.
 *
 * The return type is a discriminated union on `isDuplicate`. Callers narrow
 * with a simple `if (result.isDuplicate)` check, and TypeScript guarantees
 * that `executionMode` / `decision` are only accessible on the `false` branch.
 *
 * Queue enqueueing is NOT done here — the caller is responsible for acting
 * on `executionMode`.
 */

import type { Types } from 'mongoose';
import type { FastifyBaseLogger } from 'fastify';
import { findOrCreateDerivedAsset } from './asset.repository';
import {
  decideExecutionMode,
  type DecisionConfig,
  type DecisionResult,
  type ExecutionMode,
} from '../../lib/transform-decision';
import type { IAssetTransform, LeanAsset } from './asset.model';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TransformDeduplicated {
  /** The existing derived asset (may be pending, processing, ready, or failed). */
  asset: LeanAsset;
  /** true — an existing derived asset was found; no processing is needed. */
  isDuplicate: true;
}

export interface TransformDecision {
  /** The newly created derived asset record (status: 'pending'). */
  asset: LeanAsset;
  /** false — this is a new transform; the caller must arrange for processing. */
  isDuplicate: false;
  /** Whether to process synchronously or route to the async queue. */
  executionMode: ExecutionMode;
  /** Full decision context, including complexity score and reason string. */
  decision: DecisionResult;
}

/** Discriminated union — narrow with `if (result.isDuplicate)`. */
export type TransformResult = TransformDeduplicated | TransformDecision;

// ─── Service ──────────────────────────────────────────────────────────────────

/**
 * Resolves a transform request to either an existing derived asset (dedup)
 * or a new pending asset with an execution-mode decision.
 *
 * @param params.sourceAssetId   ObjectId of the original (source) asset.
 * @param params.sourceSizeBytes Byte size of the source image — needed by the
 *                               decision engine; the caller must read this from
 *                               the source asset's `file.sizeBytes`.
 * @param params.transform       Fully-resolved transform parameters.
 * @param log                    Request-scoped logger, already bound to reqId.
 * @param decisionConfig         Optional decision config override. Pass an
 *                               explicit value in tests; omit in production.
 */
export async function resolveTransform(
  params: {
    sourceAssetId:   Types.ObjectId;
    sourceSizeBytes: number;
    transform:       IAssetTransform;
  },
  log: FastifyBaseLogger,
  decisionConfig?: DecisionConfig,
): Promise<TransformResult> {
  const { sourceAssetId, sourceSizeBytes, transform } = params;

  // ── Step 1: deduplication ─────────────────────────────────────────────────
  //
  // findOrCreateDerivedAsset is TOCTOU-safe at the database level via the
  // unique sparse index on (sourceAssetId, transformSignature). If a concurrent
  // request races past the initial findOne, the E11000 path retries and returns
  // the winning document. See asset.repository.ts for the full strategy.
  const { asset, created } = await findOrCreateDerivedAsset({
    sourceAssetId,
    transform,
  });

  if (!created) {
    log.info(
      { assetId: asset._id.toString(), status: asset.status },
      'transform deduplicated — returning existing derived asset',
    );
    return { asset, isDuplicate: true };
  }

  // ── Step 2: execution-mode decision ───────────────────────────────────────
  const decision = decideExecutionMode({ sourceSizeBytes, transform }, decisionConfig);

  log.info(
    {
      assetId:         asset._id.toString(),
      mode:            decision.mode,
      complexityScore: decision.complexityScore,
      reason:          decision.reason,
    },
    'transform decision made',
  );

  return {
    asset,
    isDuplicate:   false,
    executionMode: decision.mode,
    decision,
  };
}
