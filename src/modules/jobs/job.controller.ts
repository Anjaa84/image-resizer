/**
 * JobController — thin HTTP boundary for job status queries.
 *
 * Handler responsibilities:
 *   1. Validate path parameter
 *   2. Call job.service.getJobStatus
 *   3. Shape the response — include output asset for completed jobs,
 *      safe errorMessage for failed jobs
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import { BadRequestError } from '../../lib/errors';
import { getJobStatus } from './job.service';
import { jobIdParamSchema } from './job.schema';

// ─── GET /api/v1/jobs/:jobId ──────────────────────────────────────────────────

export async function getJobStatusHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const paramResult = jobIdParamSchema.safeParse(req.params);
  if (!paramResult.success) {
    throw new BadRequestError('Invalid job ID — must be a 24-character hex ObjectId');
  }

  const { job, outputAsset } = await getJobStatus(paramResult.data.jobId);

  // ── Base fields present on every status ──────────────────────────────────
  const response: Record<string, unknown> = {
    id:            job._id.toString(),
    type:          job.type,
    status:        job.status,
    inputAssetId:  job.inputAssetId.toString(),
    outputAssetId: job.outputAssetId?.toString(),
    attempts:      job.attempts,
    maxAttempts:   job.maxAttempts,
    createdAt:     job.createdAt,
    updatedAt:     job.updatedAt,
  };

  // ── Timing fields — present only once set ─────────────────────────────────
  if (job.startedAt)   response['startedAt']   = job.startedAt;
  if (job.completedAt) response['completedAt'] = job.completedAt;

  // ── Status-specific fields ─────────────────────────────────────────────────

  if (job.status === 'failed') {
    // errorMessage is set from err.message by the worker — not a raw stack.
    // Include it so clients can surface a human-readable reason without
    // exposing internal implementation details.
    if (job.errorMessage) {
      response['errorMessage'] = job.errorMessage;
    }
  }

  if (job.status === 'completed' && outputAsset) {
    response['outputAsset'] = {
      id:        outputAsset._id.toString(),
      status:    outputAsset.status,
      transform: outputAsset.transform,
      file:      outputAsset.file,
      storage:   outputAsset.storage,
      createdAt: outputAsset.createdAt,
    };
  }

  void reply.code(200).send(response);
}
