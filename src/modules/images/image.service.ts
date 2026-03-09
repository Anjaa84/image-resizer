/**
 * ImageService — orchestrates upload, DB persistence, and job enqueueing.
 * Business logic to be implemented in the next phase.
 */
import type { MultipartFile } from '@fastify/multipart';
import type { ResizeQuery } from './image.schema';

export class ImageService {
  async enqueueResize(_file: MultipartFile, _opts: ResizeQuery): Promise<{ imageId: string }> {
    throw new Error('Not implemented');
  }

  async getStatus(_imageId: string): Promise<unknown> {
    throw new Error('Not implemented');
  }

  async listImages(_page: number, _limit: number): Promise<unknown> {
    throw new Error('Not implemented');
  }
}

export const imageService = new ImageService();
