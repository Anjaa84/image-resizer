/**
 * Image resize worker — runs as a separate process.
 * Picks jobs off the BullMQ queue and processes them with Sharp.
 * Business logic to be implemented in the next phase.
 */
import { Worker } from 'bullmq';
import { config } from '../config';
import { bullMQConnectionOptions } from '../queue/redis';
import { logger } from '../lib/logger';
import { connectDB } from '../db/mongoose';
import type { ImageResizeJobData } from '../queue/image.queue';

async function bootstrap(): Promise<void> {
  await connectDB();

  const worker = new Worker<ImageResizeJobData>(
    config.QUEUE_NAME,
    async (job) => {
      logger.info({ jobId: job.id, data: job.data }, 'Processing image resize job');
      // TODO: implement sharp resize logic
      throw new Error('Worker processor not yet implemented');
    },
    {
      connection: bullMQConnectionOptions,
      concurrency: config.QUEUE_CONCURRENCY,
    },
  );

  worker.on('completed', (job) => logger.info({ jobId: job.id }, 'Job completed'));
  worker.on('failed', (job, err) => logger.error({ jobId: job?.id, err }, 'Job failed'));

  logger.info(`Worker listening on queue: ${config.QUEUE_NAME}`);
}

bootstrap().catch((err) => {
  logger.fatal({ err }, 'Worker failed to start');
  process.exit(1);
});
