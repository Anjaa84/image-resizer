import { type Types } from 'mongoose';
import {
  JobModel,
  type JobPayload,
  type JobStatus,
  type JobType,
  type LeanJob,
} from './job.model';

// ─── Input Types ──────────────────────────────────────────────────────────────

export interface CreateJobInput {
  type: JobType;
  bullJobId: string;
  inputAssetId: Types.ObjectId;
  outputAssetId: Types.ObjectId;
  payload: JobPayload;
  maxAttempts?: number;
}

// ─── Read Operations ──────────────────────────────────────────────────────────

/**
 * Finds a job by its MongoDB ObjectId.
 */
export async function findJobById(
  id: Types.ObjectId | string,
): Promise<LeanJob | null> {
  return JobModel.findById(id).lean<LeanJob>().exec();
}

/**
 * Finds a job by its BullMQ job ID. This is the primary lookup used by the
 * worker on every status transition — it must be fast.
 * Backed by the unique index uq_bull_job_id.
 */
export async function findJobByBullId(bullJobId: string): Promise<LeanJob | null> {
  return JobModel.findOne({ bullJobId }).lean<LeanJob>().exec();
}

/**
 * Lists all jobs associated with a given input asset, sorted newest-first.
 * Used to display the processing history for an asset.
 * Backed by idx_input_asset_created.
 */
export async function findJobsByInputAsset(
  inputAssetId: Types.ObjectId,
): Promise<LeanJob[]> {
  return JobModel
    .find({ inputAssetId })
    .sort({ createdAt: -1 })
    .lean<LeanJob[]>()
    .exec();
}

/**
 * Reverse lookup: finds the job that produced a given derived asset.
 * Backed by the sparse index idx_output_asset.
 */
export async function findJobByOutputAsset(
  outputAssetId: Types.ObjectId,
): Promise<LeanJob | null> {
  return JobModel.findOne({ outputAssetId }).lean<LeanJob>().exec();
}

// ─── Write Operations ─────────────────────────────────────────────────────────

/**
 * Creates a job record in 'queued' state.
 *
 * Call this immediately after the BullMQ job is added to the queue so the
 * bullJobId is known. The MongoDB record and the BullMQ entry should be
 * created in close proximity — if the DB insert fails, the BullMQ job should
 * be removed (or left to expire); if BullMQ insertion fails, the DB record
 * should not be created at all.
 */
export async function createJob(input: CreateJobInput): Promise<LeanJob> {
  const doc = await JobModel.create({
    type: input.type,
    status: 'queued',
    bullJobId: input.bullJobId,
    inputAssetId: input.inputAssetId,
    outputAssetId: input.outputAssetId,
    payload: input.payload,
    maxAttempts: input.maxAttempts ?? 3,
    attempts: 0,
  });
  return doc.toObject() as LeanJob;
}

// ─── Status Transition Operations ─────────────────────────────────────────────
//
// These are the only functions that mutate job status. Each encodes a valid
// state transition. Invalid transitions (e.g., completed → active) are not
// possible through this API — callers only have access to these named functions.

/**
 * Transitions queued → active and increments the attempt counter.
 *
 * `startedAt` is set only on the first attempt (attempts was 0) so it
 * reflects when work first began, not when the latest retry started.
 * Uses a single atomic findOneAndUpdate to avoid race conditions.
 */
export async function markJobActive(bullJobId: string): Promise<LeanJob | null> {
  return JobModel.findOneAndUpdate(
    { bullJobId, status: { $in: ['queued', 'active'] } },
    [
      {
        $set: {
          status: 'active',
          attempts: { $add: ['$attempts', 1] },
          // Set startedAt only if this is the first attempt
          startedAt: {
            $cond: {
              if: { $eq: ['$attempts', 0] },
              then: new Date(),
              else: '$startedAt',
            },
          },
        },
      },
    ],
    { new: true, lean: true },
  ).exec() as Promise<LeanJob | null>;
}

/**
 * Transitions active → completed.
 * Sets `outputAssetId` and `completedAt`. The asset status update is handled
 * separately by the worker after calling this function.
 */
export async function markJobCompleted(
  bullJobId: string,
  outputAssetId: Types.ObjectId,
): Promise<LeanJob | null> {
  return JobModel.findOneAndUpdate(
    { bullJobId },
    {
      $set: {
        status: 'completed',
        outputAssetId,
        completedAt: new Date(),
      },
    },
    { new: true, lean: true },
  ).exec() as Promise<LeanJob | null>;
}

/**
 * Transitions active → failed.
 * Stores the error message from the last failed attempt and sets `completedAt`
 * as the terminal timestamp (for time-to-resolution metrics).
 */
export async function markJobFailed(
  bullJobId: string,
  errorMessage: string,
): Promise<LeanJob | null> {
  return JobModel.findOneAndUpdate(
    { bullJobId },
    {
      $set: {
        status: 'failed',
        errorMessage,
        completedAt: new Date(),
      },
    },
    { new: true, lean: true },
  ).exec() as Promise<LeanJob | null>;
}

/**
 * Transitions any non-terminal status → cancelled.
 * Only valid for jobs that have not yet reached completed or failed.
 * Returns null if the job is already in a terminal state.
 */
export async function cancelJob(bullJobId: string): Promise<LeanJob | null> {
  return JobModel.findOneAndUpdate(
    { bullJobId, status: { $nin: ['completed', 'failed', 'cancelled'] } },
    { $set: { status: 'cancelled', completedAt: new Date() } },
    { new: true, lean: true },
  ).exec() as Promise<LeanJob | null>;
}
