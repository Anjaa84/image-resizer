import { z } from 'zod';

export const jobIdParamSchema = z.object({
  jobId: z
    .string()
    .regex(/^[a-f\d]{24}$/i, 'Must be a valid 24-character hex ObjectId'),
});
