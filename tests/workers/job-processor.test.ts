/**
 * Unit tests for job-processor.ts
 *
 * All I/O dependencies are mocked so the test suite runs without a
 * real MongoDB, Redis, or filesystem.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

// ── Mock all I/O modules before importing the module under test ──────────────

vi.mock('../../src/storage', () => ({
  storage: {
    read:   vi.fn(),
    save:   vi.fn(),
    getUrl: vi.fn(),
  },
  derivedKey: vi.fn(),
}));

vi.mock('../../src/lib/image-processor', () => ({
  processImage: vi.fn(),
}));

vi.mock('../../src/lib/transform-signature', () => ({
  computeTransformSignature: vi.fn(),
}));

vi.mock('../../src/modules/jobs/job.repository', () => ({
  markJobActive:    vi.fn(),
  markJobCompleted: vi.fn(),
  markJobFailed:    vi.fn(),
}));

vi.mock('../../src/modules/images/asset.repository', () => ({
  updateAssetStatus: vi.fn(),
}));

vi.mock('../../src/lib/logger', () => ({
  logger: {
    info:  vi.fn(),
    warn:  vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

vi.mock('../../src/config', () => ({
  config: {
    STORAGE_DRIVER: 'local',
    S3_BUCKET: undefined,
  },
}));

// ── Import module under test (after mocks are registered) ────────────────────

import { executeTransformJob, handleFinalJobFailure } from '../../src/workers/job-processor';
import { storage, derivedKey } from '../../src/storage';
import { processImage } from '../../src/lib/image-processor';
import { computeTransformSignature } from '../../src/lib/transform-signature';
import { markJobActive, markJobCompleted, markJobFailed } from '../../src/modules/jobs/job.repository';
import { updateAssetStatus } from '../../src/modules/images/asset.repository';
import type { ImageJobPayload } from '../../src/queue/job-payload.types';

// ── Typed mock helpers ────────────────────────────────────────────────────────

const mockStorage           = storage as { read: ReturnType<typeof vi.fn>; save: ReturnType<typeof vi.fn>; getUrl: ReturnType<typeof vi.fn> };
const mockDerivedKey        = derivedKey as ReturnType<typeof vi.fn>;
const mockProcessImage      = processImage as ReturnType<typeof vi.fn>;
const mockComputeSig        = computeTransformSignature as ReturnType<typeof vi.fn>;
const mockMarkJobActive     = markJobActive as ReturnType<typeof vi.fn>;
const mockMarkJobCompleted  = markJobCompleted as ReturnType<typeof vi.fn>;
const mockMarkJobFailed     = markJobFailed as ReturnType<typeof vi.fn>;
const mockUpdateAssetStatus = updateAssetStatus as ReturnType<typeof vi.fn>;

// ── Shared fixtures ───────────────────────────────────────────────────────────

const SOURCE_ASSET_ID  = new Types.ObjectId().toHexString();
const OUTPUT_ASSET_ID  = new Types.ObjectId().toHexString();
const BULL_JOB_ID      = 'bull-job-42';
const SOURCE_KEY       = 'originals/abc123.jpg';
const OUTPUT_KEY       = 'derived/sourceId/sig.webp';
const OUTPUT_URL       = 'http://localhost:3000/derived/sourceId/sig.webp';
const TRANSFORM_SIG    = 'deadbeef';

const TRANSFORM = {
  width:     800,
  height:    600,
  format:    'webp' as const,
  quality:   85,
  fit:       'cover' as const,
  rotate:    0,
  grayscale: false,
};

const PAYLOAD: ImageJobPayload = {
  jobType:          'resize',
  mongoJobId:       new Types.ObjectId().toHexString(),
  sourceAssetId:    SOURCE_ASSET_ID,
  sourceStorageKey: SOURCE_KEY,
  outputAssetId:    OUTPUT_ASSET_ID,
  transform:        TRANSFORM,
};

const SOURCE_BUFFER  = Buffer.from('fake-source-image');
const OUTPUT_BUFFER  = Buffer.from('fake-output-image');

const PROCESS_RESULT = {
  buffer:    OUTPUT_BUFFER,
  mimeType:  'image/webp',
  width:     800,
  height:    600,
  sizeBytes: OUTPUT_BUFFER.length,
};

// ── Test suite ────────────────────────────────────────────────────────────────

describe('executeTransformJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Happy-path defaults
    mockMarkJobActive.mockResolvedValue({ _id: new Types.ObjectId() });
    mockUpdateAssetStatus.mockResolvedValue(null);
    mockStorage.read.mockResolvedValue(SOURCE_BUFFER);
    mockProcessImage.mockResolvedValue(PROCESS_RESULT);
    mockComputeSig.mockReturnValue(TRANSFORM_SIG);
    mockDerivedKey.mockReturnValue(OUTPUT_KEY);
    mockStorage.save.mockResolvedValue(undefined);
    mockStorage.getUrl.mockReturnValue(OUTPUT_URL);
    mockMarkJobCompleted.mockResolvedValue(null);
  });

  describe('successful job completion', () => {
    it('calls all 8 pipeline steps in order', async () => {
      const callOrder: string[] = [];

      mockMarkJobActive.mockImplementation(async () => {
        callOrder.push('markJobActive');
        return { _id: new Types.ObjectId() };
      });
      mockUpdateAssetStatus.mockImplementation(async (_id: unknown, status: string) => {
        callOrder.push(`updateAssetStatus:${status}`);
        return null;
      });
      mockStorage.read.mockImplementation(async () => {
        callOrder.push('storage.read');
        return SOURCE_BUFFER;
      });
      mockProcessImage.mockImplementation(async () => {
        callOrder.push('processImage');
        return PROCESS_RESULT;
      });
      mockStorage.save.mockImplementation(async () => {
        callOrder.push('storage.save');
      });
      mockMarkJobCompleted.mockImplementation(async () => {
        callOrder.push('markJobCompleted');
        return null;
      });

      await executeTransformJob(PAYLOAD, BULL_JOB_ID);

      expect(callOrder).toEqual([
        'markJobActive',
        'updateAssetStatus:processing',
        'storage.read',
        'processImage',
        'storage.save',
        'updateAssetStatus:ready',
        'markJobCompleted',
      ]);
    });

    it('marks the job active with the bullJobId', async () => {
      await executeTransformJob(PAYLOAD, BULL_JOB_ID);
      expect(mockMarkJobActive).toHaveBeenCalledWith(BULL_JOB_ID);
    });

    it('reads the source image from storage using sourceStorageKey', async () => {
      await executeTransformJob(PAYLOAD, BULL_JOB_ID);
      expect(mockStorage.read).toHaveBeenCalledWith(SOURCE_KEY);
    });

    it('passes the correct transform options to processImage', async () => {
      await executeTransformJob(PAYLOAD, BULL_JOB_ID);
      expect(mockProcessImage).toHaveBeenCalledWith(SOURCE_BUFFER, {
        width:     TRANSFORM.width,
        height:    TRANSFORM.height,
        format:    TRANSFORM.format,
        quality:   TRANSFORM.quality,
        fit:       TRANSFORM.fit,
        rotate:    TRANSFORM.rotate,
        grayscale: TRANSFORM.grayscale,
      });
    });

    it('computes transform signature and derives output key', async () => {
      await executeTransformJob(PAYLOAD, BULL_JOB_ID);

      expect(mockComputeSig).toHaveBeenCalledWith({
        width:     TRANSFORM.width,
        height:    TRANSFORM.height,
        format:    TRANSFORM.format,
        quality:   TRANSFORM.quality,
        fit:       TRANSFORM.fit,
        rotate:    TRANSFORM.rotate,
        grayscale: TRANSFORM.grayscale,
      });

      expect(mockDerivedKey).toHaveBeenCalledWith(
        SOURCE_ASSET_ID,
        TRANSFORM_SIG,
        TRANSFORM.format,
      );
    });

    it('saves the processed buffer to the derived output key', async () => {
      await executeTransformJob(PAYLOAD, BULL_JOB_ID);
      expect(mockStorage.save).toHaveBeenCalledWith(OUTPUT_BUFFER, OUTPUT_KEY);
    });

    it('updates asset status to ready with correct file and storage metadata', async () => {
      await executeTransformJob(PAYLOAD, BULL_JOB_ID);

      const readyCalls = (mockUpdateAssetStatus.mock.calls as unknown[][]).filter(
        (args) => args[1] === 'ready',
      );
      expect(readyCalls).toHaveLength(1);

      const [, , metadata] = readyCalls[0] as [unknown, string, { file: object; storage: object }];
      expect(metadata.file).toMatchObject({
        mimeType:  'image/webp',
        sizeBytes: PROCESS_RESULT.sizeBytes,
        width:     800,
        height:    600,
      });
      // SHA-256 hash should be a 64-char hex string
      expect((metadata.file as { hash: string }).hash).toMatch(/^[0-9a-f]{64}$/);

      expect(metadata.storage).toMatchObject({
        driver: 'local',
        key:    OUTPUT_KEY,
        url:    OUTPUT_URL,
      });
    });

    it('marks the job completed with the output asset ObjectId', async () => {
      await executeTransformJob(PAYLOAD, BULL_JOB_ID);

      expect(mockMarkJobCompleted).toHaveBeenCalledOnce();
      const [calledBullJobId, calledObjectId] = mockMarkJobCompleted.mock.calls[0] as [string, Types.ObjectId];
      expect(calledBullJobId).toBe(BULL_JOB_ID);
      expect(calledObjectId.toHexString()).toBe(OUTPUT_ASSET_ID);
    });

    it('does not throw when markJobActive returns null (missing mongo record)', async () => {
      mockMarkJobActive.mockResolvedValue(null);
      await expect(executeTransformJob(PAYLOAD, BULL_JOB_ID)).resolves.toBeUndefined();
      // Pipeline should still complete
      expect(mockMarkJobCompleted).toHaveBeenCalledOnce();
    });
  });

  describe('failure path', () => {
    it('re-throws when storage.read fails', async () => {
      const readError = new Error('S3 read timeout');
      mockStorage.read.mockRejectedValue(readError);

      await expect(executeTransformJob(PAYLOAD, BULL_JOB_ID)).rejects.toThrow('S3 read timeout');
    });

    it('does not call markJobCompleted when processImage throws', async () => {
      mockProcessImage.mockRejectedValue(new Error('Sharp pipeline error'));

      await expect(executeTransformJob(PAYLOAD, BULL_JOB_ID)).rejects.toThrow('Sharp pipeline error');
      expect(mockMarkJobCompleted).not.toHaveBeenCalled();
    });

    it('does not call markJobCompleted when storage.save fails', async () => {
      mockStorage.save.mockRejectedValue(new Error('Disk full'));

      await expect(executeTransformJob(PAYLOAD, BULL_JOB_ID)).rejects.toThrow('Disk full');
      expect(mockMarkJobCompleted).not.toHaveBeenCalled();
    });

    it('does not call markJobCompleted when updateAssetStatus(ready) fails', async () => {
      mockUpdateAssetStatus.mockImplementation(async (_id: unknown, status: string) => {
        if (status === 'ready') throw new Error('DB write failed');
        return null;
      });

      await expect(executeTransformJob(PAYLOAD, BULL_JOB_ID)).rejects.toThrow('DB write failed');
      expect(mockMarkJobCompleted).not.toHaveBeenCalled();
    });

    it('still marks asset processing before any error occurs', async () => {
      mockProcessImage.mockRejectedValue(new Error('Sharp error'));

      await expect(executeTransformJob(PAYLOAD, BULL_JOB_ID)).rejects.toThrow();

      const processingCalls = (mockUpdateAssetStatus.mock.calls as unknown[][]).filter(
        (args) => args[1] === 'processing',
      );
      expect(processingCalls).toHaveLength(1);
    });
  });
});

// ── handleFinalJobFailure ─────────────────────────────────────────────────────

describe('handleFinalJobFailure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMarkJobFailed.mockResolvedValue(null);
    mockUpdateAssetStatus.mockResolvedValue(null);
  });

  it('calls markJobFailed with bullJobId and errorMessage', async () => {
    await handleFinalJobFailure(BULL_JOB_ID, OUTPUT_ASSET_ID, 'Sharp exploded');
    expect(mockMarkJobFailed).toHaveBeenCalledWith(BULL_JOB_ID, 'Sharp exploded');
  });

  it('calls updateAssetStatus with failed for the output asset', async () => {
    await handleFinalJobFailure(BULL_JOB_ID, OUTPUT_ASSET_ID, 'timeout');

    const failedCalls = (mockUpdateAssetStatus.mock.calls as unknown[][]).filter(
      (args) => args[1] === 'failed',
    );
    expect(failedCalls).toHaveLength(1);

    const [calledObjectId] = failedCalls[0] as [Types.ObjectId];
    expect(calledObjectId.toHexString()).toBe(OUTPUT_ASSET_ID);
  });

  it('runs markJobFailed and updateAssetStatus concurrently (both called)', async () => {
    await handleFinalJobFailure(BULL_JOB_ID, OUTPUT_ASSET_ID, 'error');
    expect(mockMarkJobFailed).toHaveBeenCalledOnce();
    expect(mockUpdateAssetStatus).toHaveBeenCalledOnce();
  });

  it('re-throws if markJobFailed rejects', async () => {
    mockMarkJobFailed.mockRejectedValue(new Error('DB down'));
    await expect(
      handleFinalJobFailure(BULL_JOB_ID, OUTPUT_ASSET_ID, 'error'),
    ).rejects.toThrow('DB down');
  });
});
