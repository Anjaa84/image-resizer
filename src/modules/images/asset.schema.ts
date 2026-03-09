import { z } from 'zod';

// ─── Shared Primitives ────────────────────────────────────────────────────────

export const imageFormatSchema = z.enum(['jpeg', 'png', 'webp', 'avif']);

export const fitModeSchema = z.enum(['cover', 'contain', 'fill', 'inside', 'outside']);

export const objectIdSchema = z
  .string()
  .regex(/^[a-f\d]{24}$/i, 'Must be a valid 24-character hex ObjectId');

// ─── Transform Params ─────────────────────────────────────────────────────────

/**
 * Zod schema for the transform request — what the client sends.
 * Mirrors TransformParams in transform-signature.ts exactly.
 *
 * Defaults are intentional product decisions:
 *   format  → webp  (best compression/quality ratio for web delivery)
 *   quality → 85    (visually lossless for most images at this level)
 *   fit     → cover (fills the target box, cropping rather than distorting)
 */
export const transformParamsSchema = z.object({
  width: z.coerce
    .number()
    .int('Width must be an integer')
    .positive('Width must be positive')
    .max(10_000, 'Width cannot exceed 10,000px'),

  height: z.coerce
    .number()
    .int('Height must be an integer')
    .positive('Height must be positive')
    .max(10_000, 'Height cannot exceed 10,000px'),

  format: imageFormatSchema.default('webp'),

  quality: z.coerce
    .number()
    .int('Quality must be an integer')
    .min(1, 'Quality must be at least 1')
    .max(100, 'Quality cannot exceed 100')
    .default(85),

  fit: fitModeSchema.default('cover'),

  rotate: z.coerce
    .number()
    .int('Rotation must be a whole number of degrees')
    .min(-360, 'Rotation must be >= -360')
    .max(360, 'Rotation must be <= 360')
    .default(0),

  /**
   * Query strings are always strings, so `?grayscale=true` arrives as the
   * string "true". The preprocess step normalises "true"/"1" → true and
   * "false"/"0"/"" → false before Zod's boolean check runs.
   */
  grayscale: z.preprocess(
    (val) => {
      if (typeof val === 'boolean') return val;
      if (val === 'true' || val === '1') return true;
      if (val === 'false' || val === '0' || val === '') return false;
      return val; // let Zod handle the error for anything else
    },
    z.boolean().default(false),
  ),
});

export type TransformParamsInput = z.input<typeof transformParamsSchema>;
export type TransformParamsOutput = z.output<typeof transformParamsSchema>;

// ─── Request Schemas ──────────────────────────────────────────────────────────

/**
 * Validates the query parameters on POST /api/v1/images.
 * The multipart body carries the file; the query string carries the transform.
 */
export const uploadAssetQuerySchema = transformParamsSchema;

/**
 * Validates the :id path parameter for single-asset endpoints.
 */
export const assetIdParamSchema = z.object({
  id: objectIdSchema,
});

/**
 * Validates query parameters for the paginated asset list endpoint.
 */
export const listAssetsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(['pending', 'processing', 'ready', 'failed']).optional(),
  type: z.enum(['original', 'derived']).optional(),
});

export type ListAssetsQuery = z.infer<typeof listAssetsQuerySchema>;
