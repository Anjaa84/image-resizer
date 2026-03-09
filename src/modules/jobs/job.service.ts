/**
 * JobService — queries BullMQ and the Job collection for job status/metrics.
 * Business logic to be implemented in the next phase.
 */

export class JobService {
  async getJobStatus(_jobId: string): Promise<unknown> {
    throw new Error('Not implemented');
  }

  async retryJob(_jobId: string): Promise<void> {
    throw new Error('Not implemented');
  }
}

export const jobService = new JobService();
