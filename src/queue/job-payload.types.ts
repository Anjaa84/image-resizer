/**
 * BullMQ job payload types — what gets serialised to Redis for each job.
 *
 * ── Design intent ────────────────────────────────────────────────────────────
 *
 *   Self-contained
 *     The payload carries everything the worker needs to process a job
 *     without an extra database round-trip for the source file location.
 *     `sourceStorageKey` lets the worker call `storage.read(key)` directly.
 *
 *   Reference-bearing
 *     MongoDB IDs (`mongoJobId`, `sourceAssetId`, `outputAssetId`) let the
 *     worker update the correct Job and Asset records after processing.
 *
 *   Type-safe
 *     The discriminated `jobType` field enables TypeScript narrowing in worker
 *     switch statements, mirroring the MongoDB JobPayload union in job.model.ts.
 *
 * ── Why a separate type from JobPayload in job.model.ts? ─────────────────────
 *
 *   The MongoDB `JobPayload` (ResizePayload | ConvertPayload | ThumbnailPayload)
 *   describes the *transform parameters* stored in MongoDB alongside the job
 *   document. It is a business-domain record.
 *
 *   This BullMQ payload is the *runtime execution context* stored in Redis —
 *   it adds storage keys and asset references that the worker needs at
 *   processing time but that do not belong in the MongoDB schema.
 *
 *   Keeping them separate means:
 *     - MongoDB documents stay clean (no Redis-specific fields)
 *     - The BullMQ payload can evolve independently (e.g., adding a priority
 *       hint or a deadline field) without touching the DB schema
 *     - Existing jobs in the Redis queue remain processable if the MongoDB
 *       schema changes
 *
 * ── Transform sub-document ────────────────────────────────────────────────────
 *
 *   `TransformJobPayload` intentionally mirrors IAssetTransform from the asset
 *   model but is NOT imported from it. Decoupling keeps this type self-contained
 *   within the queue layer and stable against model refactors.
 */

// ─── Shared transform params ─────────────────────────────────────────────────

/**
 * Transform parameters embedded in every job payload.
 *
 * Mirrors IAssetTransform from asset.model.ts. Deliberately copied (not
 * imported) to keep the BullMQ payload type self-contained and stable
 * across model changes.
 */
export interface TransformJobPayload {
  width:     number;
  height:    number;
  format:    'jpeg' | 'png' | 'webp' | 'avif';
  quality:   number;                                          // 1–100
  fit:       'cover' | 'contain' | 'fill' | 'inside' | 'outside';
  rotate:    number;                                          // degrees, -360–360
  grayscale: boolean;
}

// ─── Base payload ─────────────────────────────────────────────────────────────

interface ImageJobPayloadBase {
  // ─── Discriminant ───────────────────────────────────────────────────────────
  /**
   * Mirrors the `type` field on the MongoDB Job document and the BullMQ job
   * name. The worker switches on this field to run the correct transform path.
   */
  jobType: 'resize' | 'convert' | 'thumbnail';

  // ─── MongoDB references (for status updates after processing) ──────────────

  /** MongoDB Job document _id (hex string). Used to transition job status. */
  mongoJobId: string;

  /** MongoDB Asset _id (hex string) for the source (original) asset. */
  sourceAssetId: string;

  /**
   * MongoDB Asset _id (hex string) for the output (derived) asset.
   * The derived asset record is created in 'pending' status before the job
   * is enqueued; the worker updates it to 'ready' or 'failed' after processing.
   */
  outputAssetId: string;

  // ─── Storage reference ─────────────────────────────────────────────────────

  /**
   * Driver-relative storage key for the source image.
   *
   * Passed directly to `storage.read(key)` by the worker, avoiding a DB
   * roundtrip to look up the source asset's storage key. The key is stable —
   * it is content-addressed (SHA-256 hash) and never changes after upload.
   *
   * Example: `'originals/a3f1c2....jpg'`
   */
  sourceStorageKey: string;

  // ─── Transform parameters ─────────────────────────────────────────────────

  /** The resolved, normalised transform to apply to the source image. */
  transform: TransformJobPayload;
}

// ─── Discriminated variants ───────────────────────────────────────────────────

export interface ResizeImageJobPayload extends ImageJobPayloadBase {
  jobType: 'resize';
}

export interface ConvertImageJobPayload extends ImageJobPayloadBase {
  jobType: 'convert';
}

export interface ThumbnailImageJobPayload extends ImageJobPayloadBase {
  jobType: 'thumbnail';
}

/**
 * Discriminated union on `jobType`.
 *
 * The worker switches on `payload.jobType` and TypeScript narrows to the
 * appropriate variant, ensuring each branch has the correct shape.
 *
 * Usage in worker:
 *   switch (job.data.jobType) {
 *     case 'resize':    // payload is ResizeImageJobPayload
 *     case 'convert':   // payload is ConvertImageJobPayload
 *     case 'thumbnail': // payload is ThumbnailImageJobPayload
 *   }
 */
export type ImageJobPayload =
  | ResizeImageJobPayload
  | ConvertImageJobPayload
  | ThumbnailImageJobPayload;
