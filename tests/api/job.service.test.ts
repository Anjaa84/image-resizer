/**
 * Unit tests for modules/jobs/job.service.ts
 *
 * All repository calls are mocked — no MongoDB required.
 *
 * Coverage:
 *   - queued job: returns job, no outputAsset
 *   - active job: returns job, no outputAsset
 *   - completed job: returns job + hydrated output asset
 *   - completed job where output asset has been deleted: returns job, no outputAsset
 *   - failed job: returns job with errorMessage, no outputAsset
 *   - job not found: throws NotFoundError
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../../src/modules/jobs/job.repository', () => ({
  findJobById: vi.fn(),
}));

vi.mock('../../src/modules/images/asset.repository', () => ({
  findAssetById: vi.fn(),
}));

// ── Imports after mocks ───────────────────────────────────────────────────────

import { getJobStatus } from '../../src/modules/jobs/job.service';
import { findJobById } from '../../src/modules/jobs/job.repository';
import { findAssetById } from '../../src/modules/images/asset.repository';
import { NotFoundError } from '../../src/lib/errors';
import type { LeanJob } from '../../src/modules/jobs/job.model';
import type { LeanAsset } from '../../src/modules/images/asset.model';

// ── Typed mock helpers ────────────────────────────────────────────────────────

const mockFindJob   = findJobById   as ReturnType<typeof vi.fn>;
const mockFindAsset = findAssetById as ReturnType<typeof vi.fn>;

// ── Fixtures ──────────────────────────────────────────────────────────────────

const JOB_ID           = new Types.ObjectId();
const INPUT_ASSET_ID   = new Types.ObjectId();
const OUTPUT_ASSET_ID  = new Types.ObjectId();

const BASE_JOB: LeanJob = {
  _id:          JOB_ID,
  type:         'resize',
  status:       'queued',
  bullJobId:    'bull-1',
  inputAssetId: INPUT_ASSET_ID,
  outputAssetId: OUTPUT_ASSET_ID,
  payload:      { type: 'resize', width: 800, height: 600, format: 'webp', quality: 85, fit: 'cover', rotate: 0, grayscale: false },
  attempts:     0,
  maxAttempts:  3,
  createdAt:    new Date('2025-01-01T00:00:00Z'),
  updatedAt:    new Date('2025-01-01T00:00:00Z'),
};

const OUTPUT_ASSET: LeanAsset = {
  _id:           OUTPUT_ASSET_ID,
  type:          'derived',
  status:        'ready',
  sourceAssetId: INPUT_ASSET_ID,
  transform:     { width: 800, height: 600, format: 'webp', quality: 85, fit: 'cover', rotate: 0, grayscale: false },
  file: {
    originalName: 'derived-800x600.webp',
    mimeType:     'image/webp',
    sizeBytes:    128_000,
    hash:         'abc123',
    width:        800,
    height:       600,
  },
  storage: {
    driver: 'local',
    key:    'derived/source/sig.webp',
    url:    'http://localhost:3000/derived/source/sig.webp',
  },
  createdAt: new Date('2025-01-01T00:00:10Z'),
  updatedAt: new Date('2025-01-01T00:00:10Z'),
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('getJobStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Not found ──────────────────────────────────────────────────────────────

  it('throws NotFoundError when the job does not exist', async () => {
    mockFindJob.mockResolvedValue(null);

    await expect(getJobStatus(JOB_ID.toHexString())).rejects.toThrow(NotFoundError);
  });

  it('looks up the job by the provided ID', async () => {
    mockFindJob.mockResolvedValue(null);
    await expect(getJobStatus(JOB_ID.toHexString())).rejects.toThrow();
    expect(mockFindJob).toHaveBeenCalledWith(JOB_ID.toHexString());
  });

  // ── Queued ────────────────────────────────────────────────────────────────

  describe('queued job', () => {
    it('returns the job without outputAsset', async () => {
      mockFindJob.mockResolvedValue({ ...BASE_JOB, status: 'queued' });

      const result = await getJobStatus(JOB_ID.toHexString());

      expect(result.job.status).toBe('queued');
      expect(result.outputAsset).toBeUndefined();
    });

    it('does not query the asset repository for queued jobs', async () => {
      mockFindJob.mockResolvedValue({ ...BASE_JOB, status: 'queued' });

      await getJobStatus(JOB_ID.toHexString());

      expect(mockFindAsset).not.toHaveBeenCalled();
    });
  });

  // ── Active ────────────────────────────────────────────────────────────────

  describe('active job', () => {
    it('returns the job without outputAsset', async () => {
      mockFindJob.mockResolvedValue({
        ...BASE_JOB,
        status:    'active',
        attempts:  1,
        startedAt: new Date(),
      });

      const result = await getJobStatus(JOB_ID.toHexString());

      expect(result.job.status).toBe('active');
      expect(result.outputAsset).toBeUndefined();
    });

    it('does not query the asset repository for active jobs', async () => {
      mockFindJob.mockResolvedValue({ ...BASE_JOB, status: 'active' });

      await getJobStatus(JOB_ID.toHexString());

      expect(mockFindAsset).not.toHaveBeenCalled();
    });
  });

  // ── Completed ─────────────────────────────────────────────────────────────

  describe('completed job', () => {
    const completedJob: LeanJob = {
      ...BASE_JOB,
      status:       'completed',
      attempts:     1,
      startedAt:    new Date('2025-01-01T00:00:05Z'),
      completedAt:  new Date('2025-01-01T00:00:10Z'),
    };

    it('returns the job with the hydrated output asset', async () => {
      mockFindJob.mockResolvedValue(completedJob);
      mockFindAsset.mockResolvedValue(OUTPUT_ASSET);

      const result = await getJobStatus(JOB_ID.toHexString());

      expect(result.job.status).toBe('completed');
      expect(result.outputAsset).toBeDefined();
      expect(result.outputAsset!._id).toEqual(OUTPUT_ASSET_ID);
    });

    it('queries the asset repository with the job outputAssetId', async () => {
      mockFindJob.mockResolvedValue(completedJob);
      mockFindAsset.mockResolvedValue(OUTPUT_ASSET);

      await getJobStatus(JOB_ID.toHexString());

      expect(mockFindAsset).toHaveBeenCalledWith(OUTPUT_ASSET_ID);
    });

    it('returns undefined outputAsset when the asset has been deleted', async () => {
      mockFindJob.mockResolvedValue(completedJob);
      mockFindAsset.mockResolvedValue(null);

      const result = await getJobStatus(JOB_ID.toHexString());

      expect(result.job.status).toBe('completed');
      expect(result.outputAsset).toBeUndefined();
    });

    it('includes file and storage metadata from the output asset', async () => {
      mockFindJob.mockResolvedValue(completedJob);
      mockFindAsset.mockResolvedValue(OUTPUT_ASSET);

      const result = await getJobStatus(JOB_ID.toHexString());

      expect(result.outputAsset!.file).toMatchObject({
        mimeType:  'image/webp',
        sizeBytes: 128_000,
        width:     800,
        height:    600,
      });
      expect(result.outputAsset!.storage).toMatchObject({
        driver: 'local',
        url:    expect.stringContaining('http'),
      });
    });
  });

  // ── Failed ────────────────────────────────────────────────────────────────

  describe('failed job', () => {
    const failedJob: LeanJob = {
      ...BASE_JOB,
      status:       'failed',
      attempts:     3,
      startedAt:    new Date('2025-01-01T00:00:05Z'),
      completedAt:  new Date('2025-01-01T00:00:30Z'),
      errorMessage: 'Sharp pipeline error: unsupported image format',
    };

    it('returns the job with errorMessage', async () => {
      mockFindJob.mockResolvedValue(failedJob);

      const result = await getJobStatus(JOB_ID.toHexString());

      expect(result.job.status).toBe('failed');
      expect(result.job.errorMessage).toBe('Sharp pipeline error: unsupported image format');
    });

    it('does not query the asset repository for failed jobs', async () => {
      mockFindJob.mockResolvedValue(failedJob);

      await getJobStatus(JOB_ID.toHexString());

      expect(mockFindAsset).not.toHaveBeenCalled();
    });

    it('returns no outputAsset for failed jobs', async () => {
      mockFindJob.mockResolvedValue(failedJob);

      const result = await getJobStatus(JOB_ID.toHexString());

      expect(result.outputAsset).toBeUndefined();
    });

    it('errorMessage does not contain a stack trace', async () => {
      mockFindJob.mockResolvedValue(failedJob);

      const result = await getJobStatus(JOB_ID.toHexString());

      // A raw stack trace always starts with "Error:" followed by "    at "
      expect(result.job.errorMessage).not.toMatch(/^\s+at /m);
    });
  });
});
