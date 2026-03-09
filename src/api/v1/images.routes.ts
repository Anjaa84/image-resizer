import type { FastifyInstance } from 'fastify';
import {
  uploadAndResizeHandler,
  getImageStatusHandler,
  listImagesHandler,
} from '../../modules/images/image.controller';

export async function imageRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /api/v1/images — upload + enqueue resize job
  fastify.post('/', uploadAndResizeHandler);

  // GET  /api/v1/images — list all images (paginated)
  fastify.get('/', listImagesHandler);

  // GET  /api/v1/images/:id — get image status + result URL
  fastify.get('/:id', getImageStatusHandler);
}
