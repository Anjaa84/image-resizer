import { Queue } from 'bullmq';
import { bullMQConnectionOptions } from './redis';
import { config } from '../config';

export interface ImageResizeJobData {
  jobId: string;
  sourcePath: string;
  width: number;
  height: number;
  format: 'jpeg' | 'png' | 'webp' | 'avif';
  quality: number;
  outputPath: string;
}

export const imageQueue = new Queue<ImageResizeJobData>(config.QUEUE_NAME, {
  connection: bullMQConnectionOptions,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 200 },
  },
});
