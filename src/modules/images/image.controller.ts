/**
 * ImageController — thin HTTP boundary layer.
 *
 * Each handler's only jobs:
 *   1. Extract and validate HTTP-layer inputs (multipart parts, query params, path params)
 *   2. Call the appropriate service function
 *   3. Serialize the result into an HTTP response
 *
 * No business logic lives here. Errors thrown by service functions propagate
 * to the central error handler (src/lib/error-handler.ts) automatically.
 */
import type { FastifyRequest, FastifyReply } from 'fastify';
import { BadRequestError, PayloadTooLargeError } from '../../lib/errors';
import { uploadOriginal, MAX_UPLOAD_BYTES } from './upload.service';

// ─── Upload ───────────────────────────────────────────────────────────────────

export async function uploadAndResizeHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  // req.file() parses the next multipart part from the request stream.
  // Returns undefined when there is no file part (e.g., non-multipart request
  // or empty form). @fastify/multipart handles Content-Type validation and
  // enforces the plugin-level fileSize / files limits before we get here.
  const part = await req.file();

  if (!part) {
    throw new BadRequestError(
      'No file found in request. Upload the image as multipart/form-data with field name "file".',
    );
  }

  // Buffer the stream. The multipart plugin enforces a hard fileSize cap and
  // sets part.file.truncated when the stream was cut short. We check this
  // after toBuffer() because the truncation flag is only set after the stream
  // is fully drained.
  const buffer = await part.toBuffer();

  if (part.file.truncated) {
    throw new PayloadTooLargeError(MAX_UPLOAD_BYTES);
  }

  const { asset, deduplicated } = await uploadOriginal(
    { buffer, originalName: part.filename ?? 'upload' },
    req.log,
  );

  void reply.code(201).send({
    id:          asset._id.toString(),
    type:        asset.type,
    status:      asset.status,
    file:        asset.file,
    storage:     asset.storage,
    createdAt:   asset.createdAt,
    deduplicated,
  });
}

// ─── Get Status ───────────────────────────────────────────────────────────────

export async function getImageStatusHandler(
  _req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  reply.code(501).send({ error: 'Not implemented' });
}

// ─── List ─────────────────────────────────────────────────────────────────────

export async function listImagesHandler(
  _req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  reply.code(501).send({ error: 'Not implemented' });
}
