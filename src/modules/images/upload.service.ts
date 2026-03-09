/**
 * uploadOriginal — core business logic for the original-image upload flow.
 *
 * Responsibilities (in order):
 *   1. Enforce maximum upload size before any I/O
 *   2. Detect the real image format via Sharp (never trust client Content-Type)
 *   3. Reject unsupported formats with a clear error
 *   4. Compute a SHA-256 content hash of the raw bytes
 *   5. Return the existing asset if the exact same file has already been stored (dedup)
 *   6. Persist the file bytes through the storage abstraction
 *   7. Create the asset metadata record in MongoDB
 *
 * This module has no Fastify imports — it is deliberately isolated from the
 * HTTP layer so it can be unit-tested without spinning up an HTTP server.
 */

import crypto from 'node:crypto';
import sharp from 'sharp';
import type { FastifyBaseLogger } from 'fastify';
import { config } from '../../config';
import { storage, originalKey } from '../../storage';
import { findOriginalByHash, createOriginalAsset } from './asset.repository';
import { PayloadTooLargeError, UnsupportedMediaTypeError } from '../../lib/errors';
import type { LeanAsset } from './asset.model';

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Re-exported from config so controllers can surface the limit in error
 * messages without reaching into the config module directly.
 */
export const MAX_UPLOAD_BYTES = config.MAX_UPLOAD_BYTES;

/**
 * Full map of every format Sharp can decode → canonical MIME type.
 * Kept separate so we never lose track of Sharp's total capabilities.
 */
const ALL_SHARP_FORMATS: Record<string, string> = {
  jpeg: 'image/jpeg',
  png:  'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
  tiff: 'image/tiff',
  gif:  'image/gif',
  heic: 'image/heic',
  heif: 'image/heif',
};

/**
 * Effective accepted formats — a subset of ALL_SHARP_FORMATS filtered by
 * ALLOWED_MIME_TYPES from config. Computed once at module load time since
 * config is immutable after startup.
 *
 * Operators can restrict uploads to specific formats (e.g. jpeg+png only)
 * without changing code by adjusting ALLOWED_MIME_TYPES in the environment.
 */
const allowedMimeSet = new Set(config.ALLOWED_MIME_TYPES);
const ACCEPTED_SHARP_FORMATS: Record<string, string> = Object.fromEntries(
  Object.entries(ALL_SHARP_FORMATS).filter(([, mime]) => allowedMimeSet.has(mime)),
);

const ACCEPTED_MIME_LIST = Object.values(ACCEPTED_SHARP_FORMATS);

// ─── Types ────────────────────────────────────────────────────────────────────

export interface UploadInput {
  /** Raw bytes of the uploaded file, already consumed from the multipart stream. */
  buffer: Buffer;
  /** Client-supplied filename, stored for reference only (not for security decisions). */
  originalName: string;
}

export interface UploadResult {
  asset: LeanAsset;
  /**
   * true  — an existing original with the same content hash was found;
   *         the file was NOT re-stored and the existing asset record is returned.
   * false — this is a new file; it has been stored and a new asset record created.
   */
  deduplicated: boolean;
}

// ─── Service ──────────────────────────────────────────────────────────────────

/**
 * Processes an uploaded image file and returns the persisted asset.
 *
 * @param input  The raw file bytes and client-supplied filename.
 * @param log    Fastify request-scoped logger (already bound to the request ID).
 * @throws PayloadTooLargeError       if the buffer exceeds MAX_UPLOAD_BYTES
 * @throws UnsupportedMediaTypeError  if Sharp cannot identify the format or the
 *                                    format is not in ACCEPTED_SHARP_FORMATS
 */
export async function uploadOriginal(
  input: UploadInput,
  log: FastifyBaseLogger,
): Promise<UploadResult> {
  const { buffer, originalName } = input;

  // 1. Size gate — reject before we even hand bytes to Sharp
  if (buffer.byteLength > MAX_UPLOAD_BYTES) {
    throw new PayloadTooLargeError(MAX_UPLOAD_BYTES);
  }

  // 2. Detect real format from file header — never trust Content-Type
  let metadata: sharp.Metadata;
  try {
    metadata = await sharp(buffer).metadata();
  } catch {
    throw new UnsupportedMediaTypeError('unknown', ACCEPTED_MIME_LIST);
  }

  const detectedFormat = metadata.format; // e.g. 'jpeg', 'png', 'webp'
  if (!detectedFormat || !(detectedFormat in ACCEPTED_SHARP_FORMATS)) {
    throw new UnsupportedMediaTypeError(detectedFormat ?? 'unknown', ACCEPTED_MIME_LIST);
  }

  const mimeType = ACCEPTED_SHARP_FORMATS[detectedFormat]!;
  const width    = metadata.width;
  const height   = metadata.height;

  // Sharp can read some formats without width/height (e.g., malformed SVGs).
  // Guard so downstream code never receives undefined dimensions.
  if (!width || !height) {
    throw new UnsupportedMediaTypeError(detectedFormat, ACCEPTED_MIME_LIST);
  }

  log.info(
    { mimeType, width, height, sizeBytes: buffer.byteLength, originalName },
    'image inspected',
  );

  // 3. Compute content hash
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');

  // 4. Deduplication — return existing asset if we already have this file
  const existing = await findOriginalByHash(hash);
  if (existing) {
    log.info({ assetId: existing._id.toString(), hash }, 'original deduplicated — returning existing asset');
    return { asset: existing, deduplicated: true };
  }

  // 5. Save bytes to the configured storage backend
  const key = originalKey(hash, mimeType);
  await storage.save(buffer, key);
  const url = storage.getUrl(key);

  log.info({ key, driver: config.STORAGE_DRIVER }, 'original saved to storage');

  // 6. Persist asset metadata record
  const asset = await createOriginalAsset({
    file: {
      originalName,
      mimeType,
      sizeBytes: buffer.byteLength,
      hash,
      width,
      height,
    },
    storage: {
      driver: config.STORAGE_DRIVER,
      bucket: config.STORAGE_DRIVER === 's3' ? config.S3_BUCKET : undefined,
      key,
      url,
    },
  });

  log.info({ assetId: asset._id.toString() }, 'original asset created');

  return { asset, deduplicated: false };
}
