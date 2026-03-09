/**
 * job.service — queries the Job collection and hydrates related asset data.
 *
 * Responsibilities:
 *   - Fetch the job document by MongoDB _id
 *   - When the job is completed, load the output asset so the caller can
 *     include its file and storage metadata in the response
 *
 * What this service does NOT do:
 *   - Query BullMQ directly — the MongoDB Job document is the source of
 *     truth for API consumers; Redis is an implementation detail of the queue
 *   - Expose raw error stacks — the `errorMessage` field on the Job document
 *     is already sanitised (set from `err.message`, not the full stack trace)
 *     by the worker's failure handler
 */

import type { Types } from 'mongoose';
import { findJobById } from './job.repository';
import { findAssetById } from '../images/asset.repository';
import { NotFoundError } from '../../lib/errors';
import type { LeanJob } from './job.model';
import type { LeanAsset } from '../images/asset.model';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface JobStatusResult {
  job: LeanJob;
  /**
   * Present only when `job.status === 'completed'` and the output asset
   * record exists. Callers should check before accessing.
   */
  outputAsset?: LeanAsset;
}

// ─── Service ──────────────────────────────────────────────────────────────────

/**
 * Returns the job document plus its output asset (when completed).
 *
 * @param jobId  MongoDB Job document _id (hex string or ObjectId).
 * @throws NotFoundError when no job with the given ID exists.
 */
export async function getJobStatus(
  jobId: string | Types.ObjectId,
): Promise<JobStatusResult> {
  const job = await findJobById(jobId);

  if (!job) {
    throw new NotFoundError('Job');
  }

  // Hydrate the output asset only for completed jobs — pending/active/failed
  // jobs either have no output yet or a failed output that is not useful to
  // include as a full asset document.
  if (job.status === 'completed' && job.outputAssetId) {
    const outputAsset = await findAssetById(job.outputAssetId) ?? undefined;
    return { job, outputAsset };
  }

  return { job };
}
