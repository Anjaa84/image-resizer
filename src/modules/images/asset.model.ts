import {
  Schema,
  model,
  type Document,
  type Types,
  type CallbackWithoutResultAndOptionalError,
} from 'mongoose';
import { computeTransformSignature, type TransformParams } from '../../lib/transform-signature';

// ─── Enums / Literal Types ────────────────────────────────────────────────────

/**
 * 'original' — the file as uploaded by the client. Never modified.
 * 'derived'  — the result of a transform applied to an original.
 *
 * Only one level of derivation is allowed. Derived assets are always children
 * of an original, never of another derived asset. This keeps the lineage graph
 * flat and prevents recursive dependency chains.
 */
export type AssetType = 'original' | 'derived';

/**
 * pending    → record created; file not yet in storage (derived assets only)
 * processing → worker has the job and is running the transform
 * ready      → file written to storage; storage.url is valid and accessible
 * failed     → transform exhausted all retry attempts; see associated Job.errorMessage
 */
export type AssetStatus = 'pending' | 'processing' | 'ready' | 'failed';

export type StorageDriver = 'local' | 's3';
export type ImageFormat = 'jpeg' | 'png' | 'webp' | 'avif';
export type FitMode = 'cover' | 'contain' | 'fill' | 'inside' | 'outside';

// ─── Embedded Sub-document Interfaces ────────────────────────────────────────

/**
 * Byte-level facts about a stored file. For originals these are captured at
 * upload time. For derived assets they are populated after Sharp finishes
 * processing — not at record creation.
 *
 * `hash` is SHA-256 of the raw bytes and is the deduplication key for
 * original uploads: if two uploads produce the same hash, the second can
 * reference the existing asset without re-storing the file.
 */
export interface IAssetFile {
  originalName: string; // client-supplied filename, stored for reference only
  mimeType: string;     // detected from the file header via Sharp, NOT from Content-Type
  sizeBytes: number;
  hash: string;         // SHA-256 hex of raw file bytes
  width: number;        // pixel dimensions of the stored image
  height: number;
}

/**
 * Storage location for the asset's binary file.
 *
 * `key` is the durable, driver-relative identifier (disk path or S3 object key).
 * `url` is the client-facing access URL — it may change if CDN config changes,
 * but `key` never changes once written.
 */
export interface IAssetStorage {
  driver: StorageDriver;
  bucket?: string; // S3 bucket; absent for local storage
  key: string;
  url: string;
}

/**
 * The transform parameters applied to the source asset to produce this
 * derived asset. Stored as the resolved, canonical values — not the raw
 * client input (which may have been defaulted or clamped).
 */
export interface IAssetTransform {
  width: number;
  height: number;
  format: ImageFormat;
  quality: number;  // 1–100
  fit: FitMode;
}

// ─── Document Interface ───────────────────────────────────────────────────────

export interface IAsset extends Document {
  _id: Types.ObjectId;
  type: AssetType;

  /**
   * Present and required on derived assets; absent on originals.
   * Always references an original — never another derived asset.
   */
  sourceAssetId?: Types.ObjectId;

  /**
   * Deterministic SHA-256 hash of the canonical transform parameters.
   * Computed automatically by the pre-validate hook. Never set by hand.
   * Together with sourceAssetId this forms the deduplication compound key.
   */
  transformSignature?: string;

  /** Present and required on derived assets; absent on originals. */
  transform?: IAssetTransform;

  /**
   * Optional because derived assets in 'pending'/'processing' state have not
   * yet been transformed by Sharp — output dimensions, mime type, and size are
   * unknown until the worker completes the job.
   *
   * Required (enforced in pre-validate) for original assets, which always
   * have file metadata available at upload time.
   */
  file?: IAssetFile;

  /**
   * Optional because neither originals nor derived assets have a storage
   * location until the file has actually been written. Originals have
   * storage set at upload time; derived assets have it set by the worker.
   */
  storage?: IAssetStorage;

  status: AssetStatus;

  /**
   * Soft-delete timestamp. When present, the asset is logically deleted.
   * Physical deletion from storage is handled by a background sweep job.
   * All standard queries must include `{ deletedAt: { $exists: false } }`.
   */
  deletedAt?: Date;

  createdAt: Date;
  updatedAt: Date;
}

// ─── Lean Type ────────────────────────────────────────────────────────────────

/**
 * Plain-object representation of an Asset returned by `.lean()` queries.
 * Consumers (services, controllers) should depend on this type, not on
 * `IAsset` (which extends Document and carries Mongoose methods).
 *
 * Using this type keeps the Mongoose dependency contained to the model and
 * repository layers.
 */
export type LeanAsset = {
  _id: Types.ObjectId;
  type: AssetType;
  sourceAssetId?: Types.ObjectId;
  transformSignature?: string;
  transform?: IAssetTransform;
  file?: IAssetFile;
  storage?: IAssetStorage;
  status: AssetStatus;
  deletedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
};

// ─── Type Guards ──────────────────────────────────────────────────────────────

/**
 * Narrows an asset to one that is fully processed: `file` and `storage` are
 * guaranteed to be present. Use in worker completion handlers and in any code
 * that needs to access the output URL or dimensions.
 */
export function isReadyAsset(
  asset: LeanAsset,
): asset is LeanAsset & { file: IAssetFile; storage: IAssetStorage } {
  return asset.status === 'ready' && asset.file != null && asset.storage != null;
}

// ─── Sub-document Schemas ─────────────────────────────────────────────────────

const AssetFileSchema = new Schema<IAssetFile>(
  {
    originalName: { type: String, required: true },
    mimeType:     { type: String, required: true },
    sizeBytes:    { type: Number, required: true, min: 1 },
    hash:         { type: String, required: true },
    width:        { type: Number, required: true, min: 1 },
    height:       { type: Number, required: true, min: 1 },
  },
  { _id: false },
);

const AssetStorageSchema = new Schema<IAssetStorage>(
  {
    driver: { type: String, enum: ['local', 's3'], required: true },
    bucket: { type: String },
    key:    { type: String, required: true },
    url:    { type: String, required: true },
  },
  { _id: false },
);

const AssetTransformSchema = new Schema<IAssetTransform>(
  {
    width:   { type: Number, required: true, min: 1 },
    height:  { type: Number, required: true, min: 1 },
    format:  { type: String, enum: ['jpeg', 'png', 'webp', 'avif'], required: true },
    quality: { type: Number, required: true, min: 1, max: 100 },
    fit:     { type: String, enum: ['cover', 'contain', 'fill', 'inside', 'outside'], required: true },
  },
  { _id: false },
);

// ─── Main Schema ──────────────────────────────────────────────────────────────

const AssetSchema = new Schema<IAsset>(
  {
    type: {
      type: String,
      enum: ['original', 'derived'],
      required: true,
      immutable: true,
    },

    sourceAssetId: {
      type: Schema.Types.ObjectId,
      ref: 'Asset',
      // Required for derived; enforced conditionally in pre-validate.
    },

    transformSignature: {
      type: String,
      // Auto-computed in pre-validate. Declared here so Mongoose includes
      // it in the schema and it participates in the compound unique index.
    },

    transform: { type: AssetTransformSchema },

    // Not `required: true` — derived assets start without file/storage.
    // The pre-validate hook enforces presence based on asset type.
    file:    { type: AssetFileSchema },
    storage: { type: AssetStorageSchema },

    status: {
      type: String,
      enum: ['pending', 'processing', 'ready', 'failed'],
      default: 'pending',
      required: true,
    },

    deletedAt: { type: Date },
  },
  {
    timestamps: true,
    // autoIndex is disabled in production — indexes are managed by
    // `npm run db:indexes` (src/db/indexes.ts) as an explicit migration step.
    autoIndex: process.env['NODE_ENV'] !== 'production',
  },
);

// ─── Hooks ────────────────────────────────────────────────────────────────────

/**
 * Pre-validate enforces type-dependent invariants and computes
 * `transformSignature` from the `transform` sub-document.
 *
 * Running this before Mongoose's own validation step means errors surface
 * with meaningful messages rather than cryptic "Path `x` is required" errors.
 */
AssetSchema.pre<IAsset>(
  'validate',
  function (this: IAsset, next: CallbackWithoutResultAndOptionalError) {
    if (this.type === 'original') {
      if (this.sourceAssetId || this.transform || this.transformSignature) {
        return next(
          new Error(
            'Original assets must not have sourceAssetId, transform, or transformSignature.',
          ),
        );
      }
      // Originals always have file and storage available at creation time
      // (the file has already been saved before the record is inserted).
      if (!this.file) {
        return next(new Error('file is required for original assets.'));
      }
      if (!this.storage) {
        return next(new Error('storage is required for original assets.'));
      }
    }

    if (this.type === 'derived') {
      if (!this.sourceAssetId) {
        return next(new Error('sourceAssetId is required for derived assets.'));
      }
      if (!this.transform) {
        return next(new Error('transform is required for derived assets.'));
      }

      // Compute the canonical signature from normalized transform params.
      // This runs on every save so the signature stays consistent if params
      // are ever corrected before the job is picked up by a worker.
      const params: TransformParams = {
        width:   this.transform.width,
        height:  this.transform.height,
        format:  this.transform.format,
        quality: this.transform.quality,
        fit:     this.transform.fit,
      };
      this.transformSignature = computeTransformSignature(params);
    }

    next();
  },
);

// ─── Indexes ──────────────────────────────────────────────────────────────────

/**
 * Index rationale:
 *
 * 1. { 'file.hash': 1 }
 *    Original deduplication. Queries this when a new upload arrives to check
 *    whether identical bytes have already been stored. O(1) lookup.
 *
 * 2. { sourceAssetId: 1, transformSignature: 1 } — unique + sparse
 *    Primary deduplication index for derived assets. Unique: guarantees the
 *    same transform is never applied twice to the same source at the DB level.
 *    Sparse: excludes original assets (both fields undefined) from the
 *    uniqueness constraint — without sparse, all originals would conflict on
 *    the shared null key.
 *
 * 3. { sourceAssetId: 1 }
 *    Lists all derived variants for a given original. Without this index,
 *    listing variants requires a full collection scan.
 *
 * 4. { status: 1, createdAt: -1 }
 *    Admin/monitoring queries filtered by status, sorted by recency.
 *    Compound: `status` handles equality filter; `createdAt` covers the sort
 *    without a separate in-memory sort stage.
 *
 * 5. { deletedAt: 1 } — partial (only where deletedAt exists)
 *    Cleanup sweep: finds soft-deleted assets ready for physical deletion.
 *    Partial filter excludes live assets, keeping this index small.
 *
 * 6. { createdAt: -1 }
 *    Paginated listing of all assets sorted by recency.
 */
AssetSchema.index({ 'file.hash': 1 }, { name: 'idx_file_hash' });

AssetSchema.index(
  { sourceAssetId: 1, transformSignature: 1 },
  { unique: true, sparse: true, name: 'uq_source_transform' },
);

AssetSchema.index({ sourceAssetId: 1 },         { name: 'idx_source_asset' });
AssetSchema.index({ status: 1, createdAt: -1 }, { name: 'idx_status_created' });
AssetSchema.index(
  { deletedAt: 1 },
  { partialFilterExpression: { deletedAt: { $exists: true } }, name: 'idx_deleted_at' },
);
AssetSchema.index({ createdAt: -1 }, { name: 'idx_created_at' });

// ─── Model ────────────────────────────────────────────────────────────────────

export const AssetModel = model<IAsset>('Asset', AssetSchema);
