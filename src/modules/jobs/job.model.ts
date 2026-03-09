import { Schema, model, type Document, type Types } from 'mongoose';

// ─── Enums / Literal Types ────────────────────────────────────────────────────

/**
 * Job types supported by the worker fleet.
 *
 * Using a discriminated type here (rather than a plain string) means adding a
 * new job type requires updating this union and the payload discriminated union
 * below, making it easy to find every place that must be updated.
 *
 * 'resize'    — resize an image to target dimensions with optional format change
 * 'convert'   — change format only, no dimension change
 * 'thumbnail' — resize to a small fixed size (e.g., 128×128) for previews
 */
export type JobType = 'resize' | 'convert' | 'thumbnail';

/**
 * Job lifecycle states, mirroring BullMQ's internal states into MongoDB so
 * they are queryable via the REST API without coupling clients to Redis.
 *
 * queued     → job is in the BullMQ queue, not yet picked up by a worker
 * active     → a worker has dequeued and is processing the job
 * completed  → processing succeeded; outputAssetId is set and asset is 'ready'
 * failed     → all retry attempts exhausted; errorMessage contains the reason
 * cancelled  → job was manually cancelled before a worker picked it up
 */
export type JobStatus = 'queued' | 'active' | 'completed' | 'failed' | 'cancelled';

// ─── Payload Types (Discriminated Union) ─────────────────────────────────────

/**
 * Each job type carries its own payload shape. The `type` discriminant on the
 * payload mirrors the top-level `type` field, allowing the worker to use
 * TypeScript's type narrowing to get a fully-typed payload without casting.
 *
 * Stored as a mixed sub-document in MongoDB. Using a strict interface here
 * (rather than `Record<string, unknown>`) means the TypeScript compiler
 * enforces correctness at the enqueue site.
 */
export interface ResizePayload {
  type: 'resize';
  width: number;
  height: number;
  format: 'jpeg' | 'png' | 'webp' | 'avif';
  quality: number;
  fit: 'cover' | 'contain' | 'fill' | 'inside' | 'outside';
}

export interface ConvertPayload {
  type: 'convert';
  format: 'jpeg' | 'png' | 'webp' | 'avif';
  quality: number;
}

export interface ThumbnailPayload {
  type: 'thumbnail';
  size: number; // produces a square thumbnail (size × size)
  format: 'jpeg' | 'webp';
}

export type JobPayload = ResizePayload | ConvertPayload | ThumbnailPayload;

// ─── Document Interface ───────────────────────────────────────────────────────

export interface IJob extends Document {
  _id: Types.ObjectId;

  /**
   * Discriminates the job type. Determines which payload shape is present
   * and which transform the worker will apply.
   */
  type: JobType;

  /**
   * Current lifecycle state, kept in sync with BullMQ via worker event handlers.
   * This field is the source of truth for API consumers — they do not query Redis.
   */
  status: JobStatus;

  /**
   * The BullMQ job ID returned by queue.add(). Used to correlate this MongoDB
   * document with the BullMQ job for status updates, retries, and cancellations.
   * Unique: one MongoDB job document per BullMQ job.
   */
  bullJobId: string;

  /**
   * The asset that is the input to this job. Always an 'original' asset.
   * Immutable once set — a job's source cannot change after creation.
   */
  inputAssetId: Types.ObjectId;

  /**
   * The derived asset that this job will produce.
   * Set when the job is created (the derived asset record is created in 'pending'
   * state before the job is enqueued, so the relationship exists immediately).
   * Allows callers to know the output asset ID without waiting for completion.
   */
  outputAssetId?: Types.ObjectId;

  /**
   * Job-type-specific parameters. Stored as a mixed sub-document.
   * The `type` discriminant on the payload matches the top-level `type` field.
   */
  payload: JobPayload;

  /**
   * Number of times the worker has attempted this job, including the current
   * attempt if active. Incremented by the worker at the start of each attempt.
   * Compared against `maxAttempts` to determine whether to retry or fail.
   */
  attempts: number;

  /**
   * Maximum number of attempts before the job is moved to 'failed'.
   * Configured at enqueue time from QUEUE_MAX_ATTEMPTS env var (default: 3).
   * Stored here so it is visible via the API without querying BullMQ.
   */
  maxAttempts: number;

  /**
   * Human-readable error message from the last failed attempt.
   * Overwritten on each failure with the most recent error.
   * Present only when status === 'failed'.
   */
  errorMessage?: string;

  /**
   * Timestamp when a worker first picked up this job.
   * Set on the first attempt; not reset on retries, so it reflects when
   * work began, not when the last attempt began.
   */
  startedAt?: Date;

  /**
   * Timestamp when the job reached a terminal state (completed or failed).
   */
  completedAt?: Date;

  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ───────────────────────────────────────────────────────────────────

const JobSchema = new Schema<IJob>(
  {
    type: {
      type: String,
      enum: ['resize', 'convert', 'thumbnail'],
      required: true,
      immutable: true,
    },

    status: {
      type: String,
      enum: ['queued', 'active', 'completed', 'failed', 'cancelled'],
      default: 'queued',
      required: true,
    },

    bullJobId: {
      type: String,
      required: true,
    },

    inputAssetId: {
      type: Schema.Types.ObjectId,
      ref: 'Asset',
      required: true,
      immutable: true,
    },

    outputAssetId: {
      type: Schema.Types.ObjectId,
      ref: 'Asset',
    },

    /**
     * Mixed type intentionally. The shape is enforced at the TypeScript layer
     * (JobPayload discriminated union) and at the application service layer
     * (Zod validation before enqueueing). Storing as Mixed avoids the overhead
     * of a nested Mongoose schema on a field that varies by type.
     */
    payload: {
      type: Schema.Types.Mixed,
      required: true,
    },

    attempts: {
      type: Number,
      default: 0,
      min: 0,
    },

    maxAttempts: {
      type: Number,
      required: true,
      default: 3,
      min: 1,
    },

    errorMessage: { type: String },

    startedAt: { type: Date },
    completedAt: { type: Date },
  },
  {
    timestamps: true,
    autoIndex: process.env['NODE_ENV'] !== 'production',
  },
);

// ─── Indexes ──────────────────────────────────────────────────────────────────

/**
 * Index rationale:
 *
 * 1. { bullJobId: 1 } — unique
 *    One-to-one relationship between BullMQ job and MongoDB job document.
 *    Workers look up the MongoDB document by bullJobId on every status
 *    transition (active → completed / failed). This lookup must be fast.
 *
 * 2. { inputAssetId: 1, createdAt: -1 }
 *    Lists all jobs for a given asset, sorted by recency. Used by the
 *    "asset history" endpoint and for checking whether an in-progress job
 *    already exists for a source asset before enqueuing a duplicate.
 *    The compound index covers both the filter and the sort in one pass.
 *
 * 3. { outputAssetId: 1 } — sparse
 *    Reverse lookup: given a derived asset, find the job that produced it.
 *    Sparse because outputAssetId is undefined for jobs that have not yet
 *    produced an output (queued/active). Without sparse, all queued/active
 *    jobs would be indexed with a null key, wasting index space.
 *
 * 4. { status: 1, createdAt: -1 }
 *    Admin dashboard and monitoring queries: "show all queued jobs",
 *    "show failed jobs in the last hour". The leading `status` matches the
 *    equality filter; `createdAt` covers the sort without an additional stage.
 *
 * 5. { status: 1, type: 1 }
 *    Filter by both status and job type — useful for targeted worker monitoring
 *    (e.g., "how many thumbnail jobs are currently active?").
 */
JobSchema.index({ bullJobId: 1 }, { unique: true, name: 'uq_bull_job_id' });

JobSchema.index({ inputAssetId: 1, createdAt: -1 }, { name: 'idx_input_asset_created' });

JobSchema.index(
  { outputAssetId: 1 },
  {
    sparse: true,
    name: 'idx_output_asset',
  },
);

JobSchema.index({ status: 1, createdAt: -1 }, { name: 'idx_status_created' });

JobSchema.index({ status: 1, type: 1 }, { name: 'idx_status_type' });

// ─── Lean Type ────────────────────────────────────────────────────────────────

/**
 * Plain-object representation of a Job returned by `.lean()` queries.
 * Services and controllers depend on this type, not on `IJob` (which extends
 * Document and carries Mongoose instance methods).
 */
export type LeanJob = {
  _id: Types.ObjectId;
  type: JobType;
  status: JobStatus;
  bullJobId: string;
  inputAssetId: Types.ObjectId;
  outputAssetId?: Types.ObjectId;
  payload: JobPayload;
  attempts: number;
  maxAttempts: number;
  errorMessage?: string;
  startedAt?: Date;
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
};

// ─── Model ────────────────────────────────────────────────────────────────────

export const JobModel = model<IJob>('Job', JobSchema);
