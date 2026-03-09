/**
 * ImageController — thin HTTP layer. Validates input, delegates to ImageService.
 * Business logic to be implemented in the next phase.
 */
import type { FastifyRequest, FastifyReply } from 'fastify';

export async function uploadAndResizeHandler(
  _req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  reply.code(501).send({ error: 'Not implemented' });
}

export async function getImageStatusHandler(
  _req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  reply.code(501).send({ error: 'Not implemented' });
}

export async function listImagesHandler(
  _req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  reply.code(501).send({ error: 'Not implemented' });
}
