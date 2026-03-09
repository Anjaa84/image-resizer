/**
 * asset.service — read, download, and delete individual assets.
 *
 * Keeps controller handlers thin by centralising:
 *   - 404 propagation (NotFoundError)
 *   - Storage key resolution for downloads
 *   - Soft-delete logic with optional eager file removal
 *
 * ── Download design ───────────────────────────────────────────────────────────
 *
 * Files are read from the storage driver and returned as a Buffer. The
 * controller streams the bytes directly to the HTTP client with proper
 * Content-Type and Content-Disposition headers. This works identically for
 * both local and S3 drivers without requiring @fastify/static or presigned
 * URL support — swapping drivers requires no change here.
 *
 * ── Delete design ─────────────────────────────────────────────────────────────
 *
 * Deletion is two-phase:
 *
 *   1. Soft-delete  — always: sets `deletedAt` on the MongoDB document so the
 *      asset is invisible to all standard queries immediately. Reversible within
 *      the grace period.
 *
 *   2. Physical delete — conditional on STORAGE_DELETE_ON_ASSET_DELETE=true.
 *      When false (default), a background sweep eventually removes the file,
 *      preserving a safe rollback window and avoiding a race with any concurrent
 *      worker still processing the asset. When true, the file is removed
 *      immediately — best-effort; a storage failure is logged but does not roll
 *      back the soft-delete.
 */

import type { FastifyBaseLogger } from 'fastify';
import { storage } from '../../storage';
import { config } from '../../config';
import { findAssetById, softDeleteAsset } from './asset.repository';
import { NotFoundError, BadRequestError } from '../../lib/errors';
import type { LeanAsset } from './asset.model';

// ─── Get ──────────────────────────────────────────────────────────────────────

/**
 * Returns a single asset by its MongoDB ObjectId.
 * @throws NotFoundError when the asset does not exist or has been soft-deleted.
 */
export async function getAsset(assetId: string): Promise<LeanAsset> {
  const asset = await findAssetById(assetId);
  if (!asset) throw new NotFoundError('Asset');
  return asset;
}

// ─── Download ─────────────────────────────────────────────────────────────────

export interface DownloadResult {
  buffer:   Buffer;
  mimeType: string;
  filename: string;
  sizeBytes: number;
}

/**
 * Reads the asset's binary file from storage and returns the bytes plus
 * the metadata needed to set HTTP response headers.
 *
 * @throws NotFoundError  when the asset does not exist or has been soft-deleted.
 * @throws BadRequestError when the asset has no storage record (not yet ready).
 */
export async function downloadAsset(assetId: string): Promise<DownloadResult> {
  const asset = await findAssetById(assetId);
  if (!asset) throw new NotFoundError('Asset');

  if (!asset.storage?.key || !asset.file) {
    throw new BadRequestError(
      `Asset is not yet available for download (status: ${asset.status})`,
    );
  }

  const buffer = await storage.read(asset.storage.key);

  return {
    buffer,
    mimeType: asset.file.mimeType,
    filename: asset.file.originalName,
    sizeBytes: buffer.length,
  };
}

// ─── Delete ───────────────────────────────────────────────────────────────────

export interface DeleteAssetResult {
  asset:       LeanAsset;
  fileDeleted: boolean;
}

/**
 * Soft-deletes an asset and optionally removes its file from storage.
 *
 * Physical file removal is gated on STORAGE_DELETE_ON_ASSET_DELETE. When the
 * storage delete fails (e.g., file already gone, network error), the failure is
 * logged and the request still succeeds — the soft-delete is not rolled back,
 * and the background sweep will handle any remaining files.
 *
 * @throws NotFoundError when the asset does not exist or has already been deleted.
 */
export async function deleteAsset(
  assetId: string,
  log: FastifyBaseLogger,
): Promise<DeleteAssetResult> {
  const asset = await findAssetById(assetId);
  if (!asset) throw new NotFoundError('Asset');

  const deleted = await softDeleteAsset(asset._id);
  // softDeleteAsset returns null if the asset was already soft-deleted
  // (the filter excludes docs with deletedAt). Treat this as not found.
  if (!deleted) throw new NotFoundError('Asset');

  let fileDeleted = false;

  if (config.STORAGE_DELETE_ON_ASSET_DELETE && asset.storage?.key) {
    try {
      await storage.delete(asset.storage.key);
      fileDeleted = true;
      log.info(
        { assetId, key: asset.storage.key },
        'File removed from storage on asset delete',
      );
    } catch (err) {
      // Storage delete failure is non-fatal: the soft-delete already committed,
      // and the background sweep will clean up the orphaned file.
      log.warn(
        { err, assetId, key: asset.storage.key },
        'Failed to remove file from storage during asset delete — will be cleaned up by background sweep',
      );
    }
  }

  return { asset: deleted, fileDeleted };
}
