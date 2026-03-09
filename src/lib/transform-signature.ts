import crypto from 'crypto';

/**
 * TransformParams represents the full set of parameters that define a unique
 * image transformation. This is the canonical type used for deduplication.
 *
 * Every field must be included and normalized before hashing. Adding a new
 * transform option (e.g., "blur", "rotate") requires adding it here so the
 * signature reflects the full transform intent.
 */
export interface TransformParams {
  width: number;
  height: number;
  format: 'jpeg' | 'png' | 'webp' | 'avif';
  quality: number;
  fit: 'cover' | 'contain' | 'fill' | 'inside' | 'outside';
}

/**
 * Computes a deterministic SHA-256 signature for a set of transform parameters.
 *
 * The signature is the deduplication key for derived assets. Two requests that
 * produce identical TransformParams — regardless of the order their fields are
 * specified — must produce the same signature.
 *
 * To guarantee this, keys are serialized in a fixed alphabetical order, not in
 * insertion order. This makes the hash stable across any calling pattern.
 *
 * Example:
 *   computeTransformSignature({ width: 800, height: 600, format: 'webp', quality: 85, fit: 'cover' })
 *   // → 'a3f1c2...' (deterministic SHA-256 hex)
 */
export function computeTransformSignature(params: TransformParams): string {
  // Serialize keys in a fixed canonical order (alphabetical).
  // Do NOT rely on object insertion order — it is not guaranteed to be stable
  // across different callers or future refactors.
  const canonical = JSON.stringify({
    fit: params.fit,
    format: params.format,
    height: params.height,
    quality: params.quality,
    width: params.width,
  });

  return crypto.createHash('sha256').update(canonical).digest('hex');
}
