/**
 * Unit tests for transform-execute.service.ts
 *
 * All I/O dependencies (DB, storage, queue, Sharp) are mocked so the suite
 * runs without any infrastructure.
 *
 * Coverage:
 *   - Duplicate transform reuse (isDuplicate = true)
 *   - Sync transform (processImage + storage inline)
 *   - Async transform (enqueue + createJob)
 *   - Invalid request: asset not found
 *   - Invalid request: asset is derived (not original)
 *   - Invalid request: asset not ready
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

// ── Mock all I/O dependencies before importing the module under test ──────────

vi.mock('../../src/modules/images/asset.repository', () => ({
  findAssetById:    vi.fn(),
  updateAssetStatus: vi.fn(),
}));

vi.mock('../../src/modules/images/transform.service', () => ({
  resolveTransform: vi.fn(),
}));

vi.mock('../../src/lib/image-processor', () => ({
  processImage: vi.fn(),
}));

vi.mock('../../src/storage', () => ({
  storage: {
    read:   vi.fn(),
    save:   vi.fn(),
    getUrl: vi.fn(),
  },
  derivedKey: vi.fn(),
}));

vi.mock('../../src/lib/transform-signature', () => ({
  computeTransformSignature: vi.fn(),
}));

vi.mock('../../src/modules/jobs/job.repository', () => ({
  createJob: vi.fn(),
}));

vi.mock('../../src/queue/image.queue', () => ({
  enqueueTransformJob: vi.fn(),
}));

vi.mock('../../src/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

vi.mock('../../src/config', () => ({
  config: {
    STORAGE_DRIVER:      'local',
    S3_BUCKET:           undefined,
    QUEUE_MAX_ATTEMPTS:  3,
    API_VERSION:         'v1',
  },
}));

// ── Import under test (after mocks) ──────────────────────────────────────────

import { executeTransformRequest } from '../../src/modules/images/transform-execute.service';
import { findAssetById, updateAssetStatus } from '../../src/modules/images/asset.repository';
import { resolveTransform } from '../../src/modules/images/transform.service';
import { processImage } from '../../src/lib/image-processor';
import { storage, derivedKey } from '../../src/storage';
import { computeTransformSignature } from '../../src/lib/transform-signature';
import { createJob } from '../../src/modules/jobs/job.repository';
import { enqueueTransformJob } from '../../src/queue/image.queue';
import { NotFoundError, BadRequestError } from '../../src/lib/errors';
import type { LeanAsset } from '../../src/modules/images/asset.model';
import type { LeanJob } from '../../src/modules/jobs/job.model';

// ── Typed mock helpers ────────────────────────────────────────────────────────

const mockFindAsset         = findAssetById as ReturnType<typeof vi.fn>;
const mockUpdateStatus      = updateAssetStatus as ReturnType<typeof vi.fn>;
const mockResolveTransform  = resolveTransform as ReturnType<typeof vi.fn>;
const mockProcessImage      = processImage as ReturnType<typeof vi.fn>;
const mockStorage           = storage as { read: ReturnType<typeof vi.fn>; save: ReturnType<typeof vi.fn>; getUrl: ReturnType<typeof vi.fn> };
const mockDerivedKey        = derivedKey as ReturnType<typeof vi.fn>;
const mockComputeSig        = computeTransformSignature as ReturnType<typeof vi.fn>;
const mockCreateJob         = createJob as ReturnType<typeof vi.fn>;
const mockEnqueue           = enqueueTransformJob as ReturnType<typeof vi.fn>;

// ── Fixtures ──────────────────────────────────────────────────────────────────

const SOURCE_ASSET_ID  = new Types.ObjectId();
const DERIVED_ASSET_ID = new Types.ObjectId();
const JOB_ID           = new Types.ObjectId();

const TRANSFORM = {
  width:     800,
  height:    600,
  format:    'webp' as const,
  quality:   85,
  fit:       'cover' as const,
  rotate:    0,
  grayscale: false,
};

const SOURCE_ASSET: LeanAsset = {
  _id:       SOURCE_ASSET_ID,
  type:      'original',
  status:    'ready',
  file: {
    originalName: 'photo.jpg',
    mimeType:     'image/jpeg',
    sizeBytes:    512_000,
    hash:         'abc',
    width:        1920,
    height:       1080,
  },
  storage: {
    driver: 'local',
    key:    'originals/abc.jpg',
    url:    'http://localhost:3000/originals/abc.jpg',
  },
  createdAt: new Date(),
  updatedAt: new Date(),
};

const DERIVED_ASSET: LeanAsset = {
  _id:           DERIVED_ASSET_ID,
  type:          'derived',
  status:        'pending',
  sourceAssetId: SOURCE_ASSET_ID,
  transform:     TRANSFORM,
  createdAt:     new Date(),
  updatedAt:     new Date(),
};

const READY_DERIVED_ASSET: LeanAsset = {
  ...DERIVED_ASSET,
  status: 'ready',
  file: {
    originalName: 'derived-800x600.webp',
    mimeType:     'image/webp',
    sizeBytes:    128_000,
    hash:         'def',
    width:        800,
    height:       600,
  },
  storage: {
    driver: 'local',
    key:    'derived/sourceId/sig.webp',
    url:    'http://localhost:3000/derived/sourceId/sig.webp',
  },
};

const LEAN_JOB: LeanJob = {
  _id:          JOB_ID,
  type:         'resize',
  status:       'queued',
  bullJobId:    'bull-1',
  inputAssetId: SOURCE_ASSET_ID,
  outputAssetId: DERIVED_ASSET_ID,
  payload:      { type: 'resize', ...TRANSFORM },
  attempts:     0,
  maxAttempts:  3,
  createdAt:    new Date(),
  updatedAt:    new Date(),
};

// Minimal logger stub
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('executeTransformRequest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindAsset.mockResolvedValue(SOURCE_ASSET);
  });

  // ── Invalid request: asset not found ───────────────────────────────────────

  describe('invalid request — asset not found', () => {
    it('throws NotFoundError when the source asset does not exist', async () => {
      mockFindAsset.mockResolvedValue(null);

      await expect(
        executeTransformRequest(SOURCE_ASSET_ID.toHexString(), TRANSFORM, log),
      ).rejects.toThrow(NotFoundError);
    });

    it('passes the asset ID to the repository', async () => {
      mockFindAsset.mockResolvedValue(null);
      await expect(
        executeTransformRequest(SOURCE_ASSET_ID.toHexString(), TRANSFORM, log),
      ).rejects.toThrow();
      expect(mockFindAsset).toHaveBeenCalledWith(SOURCE_ASSET_ID.toHexString());
    });
  });

  // ── Invalid request: asset is derived ─────────────────────────────────────

  describe('invalid request — asset is derived', () => {
    it('throws BadRequestError when the source asset is a derived asset', async () => {
      mockFindAsset.mockResolvedValue({ ...SOURCE_ASSET, type: 'derived' });
      await expect(
        executeTransformRequest(SOURCE_ASSET_ID.toHexString(), TRANSFORM, log),
      ).rejects.toThrow(BadRequestError);
    });
  });

  // ── Invalid request: asset not ready ──────────────────────────────────────

  describe('invalid request — asset not ready', () => {
    it('throws BadRequestError when the source asset status is not ready', async () => {
      mockFindAsset.mockResolvedValue({ ...SOURCE_ASSET, status: 'processing', file: undefined });
      await expect(
        executeTransformRequest(SOURCE_ASSET_ID.toHexString(), TRANSFORM, log),
      ).rejects.toThrow(BadRequestError);
    });

    it('throws BadRequestError when file metadata is missing', async () => {
      mockFindAsset.mockResolvedValue({ ...SOURCE_ASSET, status: 'ready', file: undefined });
      await expect(
        executeTransformRequest(SOURCE_ASSET_ID.toHexString(), TRANSFORM, log),
      ).rejects.toThrow(BadRequestError);
    });
  });

  // ── Duplicate transform reuse ──────────────────────────────────────────────

  describe('duplicate transform reuse', () => {
    beforeEach(() => {
      mockResolveTransform.mockResolvedValue({ isDuplicate: true, asset: READY_DERIVED_ASSET });
    });

    it('returns mode=deduplicated with the existing asset', async () => {
      const result = await executeTransformRequest(
        SOURCE_ASSET_ID.toHexString(), TRANSFORM, log,
      );
      expect(result.mode).toBe('deduplicated');
      expect(result.asset._id).toEqual(DERIVED_ASSET_ID);
    });

    it('does not call processImage or enqueue when deduplicated', async () => {
      await executeTransformRequest(SOURCE_ASSET_ID.toHexString(), TRANSFORM, log);
      expect(mockProcessImage).not.toHaveBeenCalled();
      expect(mockEnqueue).not.toHaveBeenCalled();
    });

    it('does not create a job record when deduplicated', async () => {
      await executeTransformRequest(SOURCE_ASSET_ID.toHexString(), TRANSFORM, log);
      expect(mockCreateJob).not.toHaveBeenCalled();
    });

    it('passes sourceSizeBytes from source asset to resolveTransform', async () => {
      await executeTransformRequest(SOURCE_ASSET_ID.toHexString(), TRANSFORM, log);
      expect(mockResolveTransform).toHaveBeenCalledWith(
        expect.objectContaining({ sourceSizeBytes: SOURCE_ASSET.file!.sizeBytes }),
        expect.anything(),
      );
    });
  });

  // ── Sync transform ─────────────────────────────────────────────────────────

  describe('sync transform', () => {
    const OUTPUT_BUFFER = Buffer.from('webp-bytes');
    const OUTPUT_KEY    = 'derived/source/sig.webp';
    const OUTPUT_URL    = 'http://localhost:3000/derived/source/sig.webp';

    beforeEach(() => {
      mockResolveTransform.mockResolvedValue({
        isDuplicate:   false,
        asset:         DERIVED_ASSET,
        executionMode: 'sync',
        decision:      { mode: 'sync', complexityScore: 0, reason: 'within thresholds' },
      });
      mockUpdateStatus.mockResolvedValue(READY_DERIVED_ASSET);
      mockStorage.read.mockResolvedValue(Buffer.from('source-bytes'));
      mockProcessImage.mockResolvedValue({
        buffer:    OUTPUT_BUFFER,
        mimeType:  'image/webp',
        width:     800,
        height:    600,
        sizeBytes: OUTPUT_BUFFER.length,
      });
      mockComputeSig.mockReturnValue('sig123');
      mockDerivedKey.mockReturnValue(OUTPUT_KEY);
      mockStorage.save.mockResolvedValue(undefined);
      mockStorage.getUrl.mockReturnValue(OUTPUT_URL);
    });

    it('returns mode=sync with the completed asset', async () => {
      const result = await executeTransformRequest(
        SOURCE_ASSET_ID.toHexString(), TRANSFORM, log,
      );
      expect(result.mode).toBe('sync');
      expect(result.asset.status).toBe('ready');
    });

    it('reads source image from storage using the source asset key', async () => {
      await executeTransformRequest(SOURCE_ASSET_ID.toHexString(), TRANSFORM, log);
      expect(mockStorage.read).toHaveBeenCalledWith(SOURCE_ASSET.storage!.key);
    });

    it('calls processImage with the source buffer and transform params', async () => {
      await executeTransformRequest(SOURCE_ASSET_ID.toHexString(), TRANSFORM, log);
      expect(mockProcessImage).toHaveBeenCalledWith(
        expect.any(Buffer),
        expect.objectContaining({ width: 800, height: 600, format: 'webp' }),
      );
    });

    it('saves the output buffer to the derived key', async () => {
      await executeTransformRequest(SOURCE_ASSET_ID.toHexString(), TRANSFORM, log);
      expect(mockStorage.save).toHaveBeenCalledWith(OUTPUT_BUFFER, OUTPUT_KEY);
    });

    it('updates asset status to processing then ready in order', async () => {
      const statusOrder: string[] = [];
      mockUpdateStatus.mockImplementation(async (_id: unknown, status: string) => {
        statusOrder.push(status);
        return status === 'ready' ? READY_DERIVED_ASSET : DERIVED_ASSET;
      });

      await executeTransformRequest(SOURCE_ASSET_ID.toHexString(), TRANSFORM, log);
      expect(statusOrder).toEqual(['processing', 'ready']);
    });

    it('sets file and storage metadata on the ready update', async () => {
      await executeTransformRequest(SOURCE_ASSET_ID.toHexString(), TRANSFORM, log);

      const readyCall = (mockUpdateStatus.mock.calls as unknown[][]).find(
        (args) => args[1] === 'ready',
      )!;
      const [, , metadata] = readyCall as [unknown, string, { file: object; storage: object }];
      expect(metadata.file).toMatchObject({
        mimeType:  'image/webp',
        sizeBytes: OUTPUT_BUFFER.length,
        width:     800,
        height:    600,
      });
      expect((metadata.file as { hash: string }).hash).toMatch(/^[0-9a-f]{64}$/);
      expect(metadata.storage).toMatchObject({ driver: 'local', key: OUTPUT_KEY, url: OUTPUT_URL });
    });

    it('does not enqueue a job for sync transforms', async () => {
      await executeTransformRequest(SOURCE_ASSET_ID.toHexString(), TRANSFORM, log);
      expect(mockEnqueue).not.toHaveBeenCalled();
    });

    it('does not create a MongoDB job record for sync transforms', async () => {
      await executeTransformRequest(SOURCE_ASSET_ID.toHexString(), TRANSFORM, log);
      expect(mockCreateJob).not.toHaveBeenCalled();
    });
  });

  // ── Async transform ────────────────────────────────────────────────────────

  describe('async transform', () => {
    beforeEach(() => {
      mockResolveTransform.mockResolvedValue({
        isDuplicate:   false,
        asset:         DERIVED_ASSET,
        executionMode: 'async',
        decision:      { mode: 'async', complexityScore: 0, reason: 'source too large' },
      });
      mockEnqueue.mockResolvedValue({ bullJobId: 'bull-42' });
      mockCreateJob.mockResolvedValue(LEAN_JOB);
    });

    it('returns mode=async with the pending asset and job', async () => {
      const result = await executeTransformRequest(
        SOURCE_ASSET_ID.toHexString(), TRANSFORM, log,
      );
      expect(result.mode).toBe('async');
      if (result.mode === 'async') {
        expect(result.asset.status).toBe('pending');
        expect(result.job.bullJobId).toBe('bull-1');
      }
    });

    it('enqueues a BullMQ job with the correct payload fields', async () => {
      await executeTransformRequest(SOURCE_ASSET_ID.toHexString(), TRANSFORM, log);

      expect(mockEnqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          jobType:          'resize',
          sourceStorageKey: SOURCE_ASSET.storage!.key,
          transform:        expect.objectContaining({ width: 800, height: 600, format: 'webp' }),
        }),
      );
    });

    it('creates a MongoDB job with the bullJobId returned by BullMQ', async () => {
      await executeTransformRequest(SOURCE_ASSET_ID.toHexString(), TRANSFORM, log);

      expect(mockCreateJob).toHaveBeenCalledWith(
        expect.objectContaining({
          type:      'resize',
          bullJobId: 'bull-42',
        }),
      );
    });

    it('does not process the image synchronously for async transforms', async () => {
      await executeTransformRequest(SOURCE_ASSET_ID.toHexString(), TRANSFORM, log);
      expect(mockProcessImage).not.toHaveBeenCalled();
    });

    it('does not update asset status to processing for async transforms', async () => {
      await executeTransformRequest(SOURCE_ASSET_ID.toHexString(), TRANSFORM, log);
      expect(mockUpdateStatus).not.toHaveBeenCalled();
    });
  });
});
