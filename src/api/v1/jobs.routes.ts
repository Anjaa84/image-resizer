import type { FastifyInstance } from 'fastify';
import { getJobStatusHandler } from '../../modules/jobs/job.controller';

// ─── Shared schema fragments ──────────────────────────────────────────────────

const fileSchema = {
  type: 'object',
  properties: {
    originalName: { type: 'string' },
    mimeType:     { type: 'string' },
    sizeBytes:    { type: 'number' },
    hash:         { type: 'string' },
    width:        { type: 'number' },
    height:       { type: 'number' },
  },
} as const;

const storageSchema = {
  type: 'object',
  properties: {
    driver: { type: 'string', enum: ['local', 's3'] },
    bucket: { type: 'string' },
    key:    { type: 'string' },
    url:    { type: 'string' },
  },
} as const;

const outputAssetSchema = {
  type: 'object',
  properties: {
    id:        { type: 'string' },
    status:    { type: 'string' },
    transform: { type: 'object' },
    file:      fileSchema,
    storage:   storageSchema,
    createdAt: { type: 'string', format: 'date-time' },
  },
} as const;

// ─── Routes ───────────────────────────────────────────────────────────────────

export async function jobRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /api/v1/jobs/:jobId — query job status; include output asset when completed
  fastify.get('/:jobId', {
    schema: {
      params: {
        type: 'object',
        properties: {
          jobId: { type: 'string', pattern: '^[a-f\\d]{24}$' },
        },
        required: ['jobId'],
      },
      response: {
        200: {
          description: 'Job status',
          type: 'object',
          properties: {
            id:            { type: 'string' },
            type:          { type: 'string', enum: ['resize', 'convert', 'thumbnail'] },
            status:        { type: 'string', enum: ['queued', 'active', 'completed', 'failed', 'cancelled'] },
            inputAssetId:  { type: 'string' },
            outputAssetId: { type: 'string' },
            attempts:      { type: 'number' },
            maxAttempts:   { type: 'number' },
            startedAt:     { type: 'string', format: 'date-time' },
            completedAt:   { type: 'string', format: 'date-time' },
            errorMessage:  { type: 'string' },
            outputAsset:   outputAssetSchema,
            createdAt:     { type: 'string', format: 'date-time' },
            updatedAt:     { type: 'string', format: 'date-time' },
          },
        },
      },
    },
    handler: getJobStatusHandler,
  });
}
