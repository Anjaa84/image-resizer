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
import { BadRequestError, PayloadTooLargeError, ValidationError } from '../../lib/errors';
import { config } from '../../config';
import { uploadOriginal, MAX_UPLOAD_BYTES } from './upload.service';
import { executeTransformRequest } from './transform-execute.service';
import { getAsset, downloadAsset, deleteAsset } from './asset.service';
import { assetIdParamSchema, transformBodySchema } from './asset.schema';

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

// ─── Transform ────────────────────────────────────────────────────────────────

/**
 * POST /api/v1/images/:id/transform
 *
 * Accepts a source asset ID and transform parameters. Delegates entirely to
 * executeTransformRequest. Responds:
 *
 *   200  — transform completed synchronously, or an identical derived asset
 *          already existed (deduplicated). Body: derived asset metadata.
 *   202  — transform queued for async processing. Body: jobId + statusUrl.
 */
export async function transformHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  // Validate :id path param
  const paramResult = assetIdParamSchema.safeParse(req.params);
  if (!paramResult.success) {
    throw new BadRequestError('Invalid asset ID — must be a 24-character hex ObjectId');
  }

  // Validate request body
  const bodyResult = transformBodySchema.safeParse(req.body);
  if (!bodyResult.success) {
    throw new ValidationError(
      'Invalid transform options',
      bodyResult.error.flatten().fieldErrors,
    );
  }

  const result = await executeTransformRequest(
    paramResult.data.id,
    bodyResult.data,
    req.log,
  );

  // ── Async: 202 Accepted ───────────────────────────────────────────────────
  if (result.mode === 'async') {
    void reply.code(202).send({
      jobId:     result.job._id.toString(),
      bullJobId: result.job.bullJobId,
      assetId:   result.asset._id.toString(),
      status:    result.job.status,
      statusUrl: `/api/${config.API_VERSION}/jobs/${result.job._id.toString()}`,
    });
    return;
  }

  // ── Sync or deduplicated: 200 OK ──────────────────────────────────────────
  const { asset } = result;
  void reply.code(200).send({
    id:            asset._id.toString(),
    type:          asset.type,
    status:        asset.status,
    sourceAssetId: asset.sourceAssetId?.toString(),
    transform:     asset.transform,
    file:          asset.file,
    storage:       asset.storage,
    createdAt:     asset.createdAt,
    deduplicated:  result.mode === 'deduplicated',
  });
}

// ─── Get Asset ────────────────────────────────────────────────────────────────

/** GET /api/v1/images/:id — returns full asset metadata. */
export async function getImageStatusHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const paramResult = assetIdParamSchema.safeParse(req.params);
  if (!paramResult.success) {
    throw new BadRequestError('Invalid asset ID — must be a 24-character hex ObjectId');
  }

  const asset = await getAsset(paramResult.data.id);

  void reply.code(200).send({
    id:            asset._id.toString(),
    type:          asset.type,
    status:        asset.status,
    sourceAssetId: asset.sourceAssetId?.toString(),
    transform:     asset.transform,
    file:          asset.file,
    storage:       asset.storage,
    createdAt:     asset.createdAt,
    updatedAt:     asset.updatedAt,
  });
}

// ─── Download ─────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/images/:id/download
 *
 * Streams the asset's binary file to the client. Reads bytes from the storage
 * driver (local filesystem or S3) and sends them with appropriate headers.
 * Works identically regardless of which storage driver is active.
 */
export async function downloadAssetHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const paramResult = assetIdParamSchema.safeParse(req.params);
  if (!paramResult.success) {
    throw new BadRequestError('Invalid asset ID — must be a 24-character hex ObjectId');
  }

  const { buffer, mimeType, filename, sizeBytes } = await downloadAsset(paramResult.data.id);

  void reply
    .code(200)
    .header('Content-Type', mimeType)
    .header('Content-Disposition', `attachment; filename="${filename}"`)
    .header('Content-Length', sizeBytes)
    .send(buffer);
}

// ─── Delete ───────────────────────────────────────────────────────────────────

/** DELETE /api/v1/images/:id — soft-deletes the asset; optionally removes the file. */
export async function deleteAssetHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const paramResult = assetIdParamSchema.safeParse(req.params);
  if (!paramResult.success) {
    throw new BadRequestError('Invalid asset ID — must be a 24-character hex ObjectId');
  }

  const { asset, fileDeleted } = await deleteAsset(paramResult.data.id, req.log);

  void reply.code(200).send({
    id:          asset._id.toString(),
    deleted:     true,
    fileDeleted,
  });
}

// ─── List ─────────────────────────────────────────────────────────────────────

export async function listImagesHandler(
  _req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  reply.code(501).send({ error: 'Not implemented' });
}
