import type { FastifyInstance } from 'fastify';
import {
  uploadAndResizeHandler,
  transformHandler,
  getImageStatusHandler,
  downloadAssetHandler,
  deleteAssetHandler,
  listImagesHandler,
} from '../../modules/images/image.controller';

// ─── Shared response schema fragments ────────────────────────────────────────

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

// ─── Routes ───────────────────────────────────────────────────────────────────

export async function imageRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /api/v1/images — upload an original image
  fastify.post('/', {
    schema: {
      // Multipart body is not described by JSON schema — @fastify/multipart
      // handles parsing. Only the response shape is declared here so
      // fast-json-stringify serialises the 201 response efficiently.
      response: {
        201: {
          description: 'Original image stored successfully',
          type: 'object',
          properties: {
            id:          { type: 'string' },
            type:        { type: 'string', enum: ['original'] },
            status:      { type: 'string', enum: ['ready'] },
            file:        fileSchema,
            storage:     storageSchema,
            createdAt:   { type: 'string', format: 'date-time' },
            deduplicated: { type: 'boolean' },
          },
        },
      },
    },
    handler: uploadAndResizeHandler,
  });

  // POST /api/v1/images/:id/transform — apply a transform to an uploaded original
  fastify.post('/:id/transform', {
    schema: {
      response: {
        // 200: sync execution or deduplicated — returns the derived asset
        200: {
          description: 'Transform completed (sync or deduplicated)',
          type: 'object',
          properties: {
            id:            { type: 'string' },
            type:          { type: 'string', enum: ['derived'] },
            status:        { type: 'string' },
            sourceAssetId: { type: 'string' },
            transform:     { type: 'object' },
            file:          fileSchema,
            storage:       storageSchema,
            createdAt:     { type: 'string', format: 'date-time' },
            deduplicated:  { type: 'boolean' },
          },
        },
        // 202: async execution — job enqueued, poll statusUrl for completion
        202: {
          description: 'Transform queued for async processing',
          type: 'object',
          properties: {
            jobId:     { type: 'string' },
            bullJobId: { type: 'string' },
            assetId:   { type: 'string' },
            status:    { type: 'string', enum: ['queued'] },
            statusUrl: { type: 'string' },
          },
        },
      },
    },
    handler: transformHandler,
  });

  // GET  /api/v1/images — list all images (paginated)
  fastify.get('/', listImagesHandler);

  // GET /api/v1/images/:id/download — stream the asset binary to the client
  // Must be declared before /:id so Fastify's router matches the 2-segment
  // path /:id/download before trying the 1-segment /:id pattern.
  fastify.get('/:id/download', {
    schema: {
      params: {
        type: 'object',
        properties: { id: { type: 'string', pattern: '^[a-f\\d]{24}$' } },
        required: ['id'],
      },
      // Binary response — no JSON response schema.
    },
    handler: downloadAssetHandler,
  });

  // GET  /api/v1/images/:id — return full asset metadata
  fastify.get('/:id', {
    schema: {
      params: {
        type: 'object',
        properties: { id: { type: 'string', pattern: '^[a-f\\d]{24}$' } },
        required: ['id'],
      },
      response: {
        200: {
          type: 'object',
          properties: {
            id:            { type: 'string' },
            type:          { type: 'string', enum: ['original', 'derived'] },
            status:        { type: 'string' },
            sourceAssetId: { type: 'string' },
            transform:     { type: 'object' },
            file:          fileSchema,
            storage:       storageSchema,
            createdAt:     { type: 'string', format: 'date-time' },
            updatedAt:     { type: 'string', format: 'date-time' },
          },
        },
      },
    },
    handler: getImageStatusHandler,
  });

  // DELETE /api/v1/images/:id — soft-delete asset; optionally remove file
  fastify.delete('/:id', {
    schema: {
      params: {
        type: 'object',
        properties: { id: { type: 'string', pattern: '^[a-f\\d]{24}$' } },
        required: ['id'],
      },
      response: {
        200: {
          type: 'object',
          properties: {
            id:          { type: 'string' },
            deleted:     { type: 'boolean' },
            fileDeleted: { type: 'boolean' },
          },
        },
      },
    },
    handler: deleteAssetHandler,
  });
}
