import type { ImageFormat } from '../modules/images/asset.model';

/**
 * Deterministic storage key generation.
 *
 * Keys are driver-relative paths. The storage driver resolves them against
 * its own base (UPLOAD_DIR for local, S3 bucket root for S3).
 *
 * Key design principles:
 *
 *   1. Deterministic — the same input always produces the same key. This
 *      means the storage layer is naturally content-addressable: if a file
 *      is saved twice (e.g., after a retry), it lands at the same key and
 *      the second write is a safe overwrite, not a duplicate.
 *
 *   2. Namespaced — 'originals/' and 'derived/' prefixes keep the two asset
 *      types cleanly separated in both filesystem directories and S3 prefixes.
 *      In S3, listing `s3://bucket/derived/{sourceId}/` returns all variants
 *      of a single original without a full-bucket scan.
 *
 *   3. Human-readable — keys contain meaningful identifiers (content hash,
 *      sourceAssetId, transformSignature, format extension), making manual
 *      debugging and lifecycle management straightforward.
 *
 * Examples:
 *   originalKey('a3f1c2...', 'image/jpeg')
 *     → 'originals/a3f1c2....jpg'
 *
 *   derivedKey('507f1f77bcf86cd799439011', 'b9e3a1...', 'webp')
 *     → 'derived/507f1f77bcf86cd799439011/b9e3a1....webp'
 */

// ─── MIME → Extension Map ─────────────────────────────────────────────────────

/**
 * Maps detected MIME types to canonical file extensions.
 *
 * Sharp detects the actual format from the file header — never from the
 * client-supplied Content-Type. Only image formats that Sharp can read are
 * listed here. Unknown types fall back to '.bin'.
 */
const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png':  '.png',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/tiff': '.tiff',
  'image/gif':  '.gif',
  'image/heic': '.heic',
  'image/heif': '.heif',
};

/**
 * Maps output format names (from IAssetTransform.format) to file extensions.
 * These are the formats Sharp can write, not input MIME types.
 */
const FORMAT_TO_EXT: Record<ImageFormat, string> = {
  jpeg: '.jpg',
  png:  '.png',
  webp: '.webp',
  avif: '.avif',
};

// ─── Key Generation ───────────────────────────────────────────────────────────

/**
 * Generates the storage key for an original (uploaded) asset.
 *
 * Uses the SHA-256 hash of the file's raw bytes as the filename. This makes
 * the key content-addressable: identical files produce identical keys, which
 * is a second line of defence against duplicate storage even if the
 * application-level dedup check in the repository is bypassed.
 *
 * @param hash     SHA-256 hex string of the raw file bytes
 * @param mimeType MIME type detected from the file header (e.g. 'image/jpeg')
 */
export function originalKey(hash: string, mimeType: string): string {
  const ext = MIME_TO_EXT[mimeType] ?? '.bin';
  return `originals/${hash}${ext}`;
}

/**
 * Generates the storage key for a derived (transformed) asset.
 *
 * Namespaced under `derived/{sourceAssetId}/` so all variants of a given
 * original can be listed by prefix — useful for bulk deletion when an
 * original is removed.
 *
 * @param sourceAssetId     MongoDB ObjectId string of the original asset
 * @param transformSignature SHA-256 hex of the canonical transform params
 * @param format            Output format (jpeg | png | webp | avif)
 */
export function derivedKey(
  sourceAssetId: string,
  transformSignature: string,
  format: ImageFormat,
): string {
  const ext = FORMAT_TO_EXT[format];
  return `derived/${sourceAssetId}/${transformSignature}${ext}`;
}

/**
 * Extracts the source asset ID from a derived key.
 * Useful for reverse-lookups and bulk operations.
 * Returns null if the key is not a valid derived key.
 */
export function sourceIdFromDerivedKey(key: string): string | null {
  const match = key.match(/^derived\/([^/]+)\//);
  return match?.[1] ?? null;
}
