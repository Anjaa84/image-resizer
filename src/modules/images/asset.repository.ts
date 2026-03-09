import { type Types } from 'mongoose';
import { AssetModel, type IAssetFile, type IAssetStorage, type IAssetTransform, type AssetStatus, type AssetType, type LeanAsset } from './asset.model';
import { computeTransformSignature } from '../../lib/transform-signature';

// ─── Input Types ──────────────────────────────────────────────────────────────

export interface CreateOriginalInput {
  file: IAssetFile;
  storage: IAssetStorage;
}

export interface CreateDerivedInput {
  sourceAssetId: Types.ObjectId;
  transform: IAssetTransform;
}

export interface ListAssetsFilter {
  type?: AssetType;
  status?: AssetStatus;
  sourceAssetId?: Types.ObjectId;
}

export interface PaginationOptions {
  page: number;   // 1-based
  limit: number;
}

export interface PagedResult<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns true when the error is a MongoDB duplicate key error (code 11000).
 *
 * Used to handle the race condition in findOrCreateDerivedAsset: if two
 * requests arrive simultaneously for the same (sourceAssetId, transform),
 * both pass the initial findOne, both attempt to insert, and one receives
 * E11000. The unique sparse index on (sourceAssetId, transformSignature) is
 * the ultimate enforcement — the application check is only an optimization
 * to avoid hitting this error path in the common case.
 */
function isDuplicateKeyError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 11000
  );
}

/** Base query filter that excludes soft-deleted assets from all standard reads. */
const ALIVE = { deletedAt: { $exists: false } } as const;

// ─── Read Operations ──────────────────────────────────────────────────────────

/**
 * Finds an asset by its MongoDB ObjectId.
 * Returns null if the asset does not exist or has been soft-deleted.
 */
export async function findAssetById(
  id: Types.ObjectId | string,
): Promise<LeanAsset | null> {
  return AssetModel.findOne({ _id: id, ...ALIVE }).lean<LeanAsset>().exec();
}

/**
 * Finds an original asset by the SHA-256 hash of its file bytes.
 *
 * This is the deduplication check for original uploads: if an incoming file's
 * hash matches an existing original, the service returns the existing asset
 * without re-storing the file.
 */
export async function findOriginalByHash(hash: string): Promise<LeanAsset | null> {
  return AssetModel
    .findOne({ type: 'original', 'file.hash': hash, ...ALIVE })
    .lean<LeanAsset>()
    .exec();
}

/**
 * Finds a derived asset by its source asset and pre-computed transform
 * signature. Used by findOrCreateDerivedAsset internally and exposed here
 * for cases where the caller already holds the signature.
 */
export async function findDerivedAsset(
  sourceAssetId: Types.ObjectId,
  transformSignature: string,
): Promise<LeanAsset | null> {
  return AssetModel
    .findOne({ sourceAssetId, transformSignature, type: 'derived', ...ALIVE })
    .lean<LeanAsset>()
    .exec();
}

/**
 * Lists all non-deleted derived assets produced from a given original.
 * Backed by idx_source_asset. Sorted newest-first.
 */
export async function listDerivedAssets(
  sourceAssetId: Types.ObjectId,
): Promise<LeanAsset[]> {
  return AssetModel
    .find({ sourceAssetId, type: 'derived', ...ALIVE })
    .sort({ createdAt: -1 })
    .lean<LeanAsset[]>()
    .exec();
}

/**
 * Paginated list of assets with optional filters.
 * Returns the page of items and the total matching count for pagination metadata.
 */
export async function listAssets(
  filter: ListAssetsFilter,
  pagination: PaginationOptions,
): Promise<PagedResult<LeanAsset>> {
  const query = {
    ...ALIVE,
    ...(filter.type && { type: filter.type }),
    ...(filter.status && { status: filter.status }),
    ...(filter.sourceAssetId && { sourceAssetId: filter.sourceAssetId }),
  };

  const skip = (pagination.page - 1) * pagination.limit;

  const [items, total] = await Promise.all([
    AssetModel
      .find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(pagination.limit)
      .lean<LeanAsset[]>()
      .exec(),
    AssetModel.countDocuments(query),
  ]);

  return { items, total, page: pagination.page, limit: pagination.limit };
}

// ─── Write Operations ─────────────────────────────────────────────────────────

/**
 * Creates an original asset record.
 *
 * Call this after the uploaded file has been successfully written to storage.
 * The caller is responsible for computing the file hash and detecting
 * dimensions with Sharp before calling this function.
 */
export async function createOriginalAsset(
  input: CreateOriginalInput,
): Promise<LeanAsset> {
  const doc = await AssetModel.create({
    type: 'original',
    status: 'ready', // originals are immediately ready — no processing required
    file: input.file,
    storage: input.storage,
  });
  return doc.toObject() as LeanAsset;
}

/**
 * Finds or creates a derived asset for the given source + transform.
 *
 * This is the primary deduplication entry point for the resize flow.
 *
 * Strategy — two layers of protection:
 *
 *   Layer 1 (application): findOne before insert. In the common case this
 *   avoids hitting the database uniqueness constraint entirely.
 *
 *   Layer 2 (database): the unique sparse index on (sourceAssetId, transformSignature)
 *   is the authoritative enforcement. If two requests race past the findOne
 *   simultaneously (TOCTOU), exactly one insert succeeds and the other receives
 *   MongoDB error E11000. The catch block retries the findOne and returns the
 *   winning document.
 *
 * Returns `created: true` when a new asset was inserted — the caller should
 * enqueue a processing job. Returns `created: false` when an existing asset
 * was found — the caller should return the existing asset and its associated
 * job to the client without enqueueing a duplicate.
 */
export async function findOrCreateDerivedAsset(
  input: CreateDerivedInput,
): Promise<{ asset: LeanAsset; created: boolean }> {
  // Compute the signature here so we can use it for the lookup query.
  // The pre-validate hook re-derives it identically on the actual save.
  const transformSignature = computeTransformSignature({
    width:   input.transform.width,
    height:  input.transform.height,
    format:  input.transform.format,
    quality: input.transform.quality,
    fit:     input.transform.fit,
  });

  // ── Layer 1: optimistic read before write ─────────────────────────────────
  const existing = await AssetModel
    .findOne({ sourceAssetId: input.sourceAssetId, transformSignature, ...ALIVE })
    .lean<LeanAsset>()
    .exec();

  if (existing) {
    return { asset: existing, created: false };
  }

  // ── Attempt insert ────────────────────────────────────────────────────────
  try {
    const doc = await AssetModel.create({
      type: 'derived',
      sourceAssetId: input.sourceAssetId,
      transform: input.transform,
      // transformSignature is set by the pre-validate hook, not manually
      status: 'pending',
    });
    return { asset: doc.toObject() as LeanAsset, created: true };
  } catch (err) {
    // ── Layer 2: race condition recovery ──────────────────────────────────
    if (isDuplicateKeyError(err)) {
      // Another concurrent request won the race and created the same derived
      // asset. The unique index on (sourceAssetId, transformSignature) rejected
      // our insert. The winning document must exist — re-query for it.
      const raced = await AssetModel
        .findOne({ sourceAssetId: input.sourceAssetId, transformSignature, ...ALIVE })
        .lean<LeanAsset>()
        .exec();

      if (!raced) {
        // Should never happen: the index rejected our insert because the
        // document exists, but then findOne found nothing. Guard anyway.
        throw new Error(
          'Duplicate key rejected insert but retry findOne returned null — ' +
          `sourceAssetId=${input.sourceAssetId.toString()}, transformSignature=${transformSignature}`,
        );
      }

      return { asset: raced, created: false };
    }

    throw err;
  }
}

// ─── Update Operations ────────────────────────────────────────────────────────

/**
 * Transitions an asset's status and optionally sets additional fields.
 *
 * Used by the worker to move a derived asset through:
 *   pending → processing  (job dequeued)
 *   processing → ready    (Sharp succeeded; pass file + storage)
 *   processing → failed   (exhausted retries)
 *
 * Returns the updated document, or null if the asset was not found.
 */
export async function updateAssetStatus(
  id: Types.ObjectId,
  status: AssetStatus,
  extra?: {
    file?: IAssetFile;
    storage?: IAssetStorage;
  },
): Promise<LeanAsset | null> {
  return AssetModel.findByIdAndUpdate(
    id,
    { $set: { status, ...extra } },
    { new: true, lean: true },
  ).exec() as Promise<LeanAsset | null>;
}

/**
 * Soft-deletes an asset by setting `deletedAt` to now.
 *
 * Does not remove the file from storage — a background cleanup job handles
 * physical deletion after a configurable grace period.
 */
export async function softDeleteAsset(
  id: Types.ObjectId,
): Promise<LeanAsset | null> {
  return AssetModel.findByIdAndUpdate(
    id,
    { $set: { deletedAt: new Date() } },
    { new: true, lean: true },
  ).exec() as Promise<LeanAsset | null>;
}
