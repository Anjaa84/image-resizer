import type { FastifyInstance } from 'fastify';
import {
  uploadAndResizeHandler,
  getImageStatusHandler,
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

  // GET  /api/v1/images — list all images (paginated)
  fastify.get('/', listImagesHandler);

  // GET  /api/v1/images/:id — get image status + result URL
  fastify.get('/:id', getImageStatusHandler);
}
