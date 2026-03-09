import { z } from 'zod';

export const resizeQuerySchema = z.object({
  width: z.coerce.number().int().positive().max(10000),
  height: z.coerce.number().int().positive().max(10000),
  format: z.enum(['jpeg', 'png', 'webp', 'avif']).default('webp'),
  quality: z.coerce.number().int().min(1).max(100).default(80),
});

export type ResizeQuery = z.infer<typeof resizeQuerySchema>;

export const imageIdSchema = z.object({
  id: z.string().length(24, 'Must be a valid MongoDB ObjectId'),
});
