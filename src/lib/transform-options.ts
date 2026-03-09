import { z } from 'zod';

/**
 * Internal Zod schema for validated transform options.
 *
 * This schema is used by `image-processor.ts` after the HTTP layer has already
 * coerced and defaulted the values from the query string. No coercion here —
 * at this point inputs are expected to be the correct types already.
 *
 * Defaults are intentional product decisions:
 *   format   → webp  (best compression/quality ratio for web delivery)
 *   quality  → 85    (visually lossless for most images at this level)
 *   fit      → cover (fills the target box, cropping rather than distorting)
 *   rotate   → 0     (no rotation)
 *   grayscale → false (preserve colour)
 */
export const transformOptionsSchema = z.object({
  width: z
    .number()
    .int('Width must be an integer')
    .positive('Width must be positive')
    .max(10_000, 'Width cannot exceed 10,000px')
    .optional(),

  height: z
    .number()
    .int('Height must be an integer')
    .positive('Height must be positive')
    .max(10_000, 'Height cannot exceed 10,000px')
    .optional(),

  format: z.enum(['jpeg', 'png', 'webp', 'avif']).default('webp'),

  quality: z
    .number()
    .int('Quality must be an integer')
    .min(1, 'Quality must be at least 1')
    .max(100, 'Quality cannot exceed 100')
    .default(85),

  fit: z
    .enum(['cover', 'contain', 'fill', 'inside', 'outside'])
    .default('cover'),

  rotate: z
    .number()
    .int('Rotation must be a whole number of degrees')
    .min(-360, 'Rotation must be >= -360')
    .max(360, 'Rotation must be <= 360')
    .default(0),

  grayscale: z.boolean().default(false),
});

export type TransformOptions = z.output<typeof transformOptionsSchema>;
export type TransformOptionsInput = z.input<typeof transformOptionsSchema>;
