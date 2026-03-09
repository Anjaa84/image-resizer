/**
 * Unit tests for modules/images/asset.service.ts
 *
 * Covers: getAsset, downloadAsset, deleteAsset.
 * All I/O (MongoDB, storage driver) is mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../../src/modules/images/asset.repository', () => ({
  findAssetById:   vi.fn(),
  softDeleteAsset: vi.fn(),
}));

vi.mock('../../src/storage', () => ({
  storage: {
    read:   vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('../../src/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// vi.mock factories are hoisted above const/let declarations, so a plain
// `const mockConfig = ...` is not yet initialised when the factory runs.
// vi.hoisted() lifts the initialiser into the same hoisted block as vi.mock,
// making it safely accessible inside the factory and in beforeEach blocks.
const mockConfig = vi.hoisted(() => ({
  STORAGE_DELETE_ON_ASSET_DELETE: false,
}));
vi.mock('../../src/config', () => ({ config: mockConfig }));

// ── Imports after mocks ───────────────────────────────────────────────────────

import { getAsset, downloadAsset, deleteAsset } from '../../src/modules/images/asset.service';
import { findAssetById, softDeleteAsset } from '../../src/modules/images/asset.repository';
import { storage } from '../../src/storage';
import { NotFoundError, BadRequestError } from '../../src/lib/errors';
import type { LeanAsset } from '../../src/modules/images/asset.model';

// ── Typed mock helpers ────────────────────────────────────────────────────────

const mockFindAsset  = findAssetById   as ReturnType<typeof vi.fn>;
const mockSoftDelete = softDeleteAsset as ReturnType<typeof vi.fn>;
const mockStorage    = storage as unknown as { read: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ASSET_ID = new Types.ObjectId();

const READY_ASSET: LeanAsset = {
  _id:    ASSET_ID,
  type:   'original',
  status: 'ready',
  file: {
    originalName: 'photo.jpg',
    mimeType:     'image/jpeg',
    sizeBytes:    512_000,
    hash:         'abc123',
    width:        1920,
    height:       1080,
  },
  storage: {
    driver: 'local',
    key:    'originals/abc123.jpg',
    url:    'http://localhost:3000/files/originals/abc123.jpg',
  },
  createdAt: new Date('2025-01-01T00:00:00Z'),
  updatedAt: new Date('2025-01-01T00:00:00Z'),
};

const PENDING_ASSET: LeanAsset = {
  ...READY_ASSET,
  status:  'pending',
  file:    undefined,
  storage: undefined,
};

const DELETED_ASSET: LeanAsset = { ...READY_ASSET, deletedAt: new Date() };

// Minimal logger stub
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

// ── getAsset ──────────────────────────────────────────────────────────────────

describe('getAsset', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the asset when found', async () => {
    mockFindAsset.mockResolvedValue(READY_ASSET);
    const result = await getAsset(ASSET_ID.toHexString());
    expect(result._id).toEqual(ASSET_ID);
  });

  it('throws NotFoundError when the asset does not exist', async () => {
    mockFindAsset.mockResolvedValue(null);
    await expect(getAsset(ASSET_ID.toHexString())).rejects.toThrow(NotFoundError);
  });

  it('passes the asset ID to findAssetById', async () => {
    mockFindAsset.mockResolvedValue(READY_ASSET);
    await getAsset(ASSET_ID.toHexString());
    expect(mockFindAsset).toHaveBeenCalledWith(ASSET_ID.toHexString());
  });
});

// ── downloadAsset ─────────────────────────────────────────────────────────────

describe('downloadAsset', () => {
  const FILE_BYTES = Buffer.from('jpeg-image-bytes');

  beforeEach(() => {
    vi.clearAllMocks();
    mockFindAsset.mockResolvedValue(READY_ASSET);
    mockStorage.read.mockResolvedValue(FILE_BYTES);
  });

  it('returns buffer and metadata for a ready asset', async () => {
    const result = await downloadAsset(ASSET_ID.toHexString());
    expect(result.buffer).toEqual(FILE_BYTES);
    expect(result.mimeType).toBe('image/jpeg');
    expect(result.filename).toBe('photo.jpg');
    expect(result.sizeBytes).toBe(FILE_BYTES.length);
  });

  it('reads from storage using the asset storage key', async () => {
    await downloadAsset(ASSET_ID.toHexString());
    expect(mockStorage.read).toHaveBeenCalledWith(READY_ASSET.storage!.key);
  });

  it('throws NotFoundError when the asset does not exist', async () => {
    mockFindAsset.mockResolvedValue(null);
    await expect(downloadAsset(ASSET_ID.toHexString())).rejects.toThrow(NotFoundError);
  });

  it('throws BadRequestError when the asset has no storage (pending/processing)', async () => {
    mockFindAsset.mockResolvedValue(PENDING_ASSET);
    await expect(downloadAsset(ASSET_ID.toHexString())).rejects.toThrow(BadRequestError);
  });

  it('includes the asset status in the BadRequestError message', async () => {
    mockFindAsset.mockResolvedValue(PENDING_ASSET);
    await expect(downloadAsset(ASSET_ID.toHexString())).rejects.toThrow(/pending/i);
  });

  it('does not call storage.read for assets without storage', async () => {
    mockFindAsset.mockResolvedValue(PENDING_ASSET);
    await expect(downloadAsset(ASSET_ID.toHexString())).rejects.toThrow();
    expect(mockStorage.read).not.toHaveBeenCalled();
  });
});

// ── deleteAsset ───────────────────────────────────────────────────────────────

describe('deleteAsset', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.STORAGE_DELETE_ON_ASSET_DELETE = false; // reset to default before each test
    mockFindAsset.mockResolvedValue(READY_ASSET);
    mockSoftDelete.mockResolvedValue(DELETED_ASSET);
    mockStorage.delete.mockResolvedValue(undefined);
  });

  it('throws NotFoundError when the asset does not exist', async () => {
    mockFindAsset.mockResolvedValue(null);
    await expect(deleteAsset(ASSET_ID.toHexString(), log)).rejects.toThrow(NotFoundError);
  });

  it('throws NotFoundError when the asset was already soft-deleted', async () => {
    // softDeleteAsset returns null when the filter on `deletedAt: {$exists: false}` misses
    mockSoftDelete.mockResolvedValue(null);
    await expect(deleteAsset(ASSET_ID.toHexString(), log)).rejects.toThrow(NotFoundError);
  });

  it('returns the soft-deleted asset document', async () => {
    const result = await deleteAsset(ASSET_ID.toHexString(), log);
    expect(result.asset._id).toEqual(ASSET_ID);
    expect(result.asset.deletedAt).toBeDefined();
  });

  it('calls softDeleteAsset with the asset ObjectId', async () => {
    await deleteAsset(ASSET_ID.toHexString(), log);
    expect(mockSoftDelete).toHaveBeenCalledWith(ASSET_ID);
  });

  // ── STORAGE_DELETE_ON_ASSET_DELETE = false (default) ────────────────────────

  describe('when STORAGE_DELETE_ON_ASSET_DELETE is false', () => {
    it('does not call storage.delete', async () => {
      await deleteAsset(ASSET_ID.toHexString(), log);
      expect(mockStorage.delete).not.toHaveBeenCalled();
    });

    it('returns fileDeleted: false', async () => {
      const result = await deleteAsset(ASSET_ID.toHexString(), log);
      expect(result.fileDeleted).toBe(false);
    });
  });

  // ── STORAGE_DELETE_ON_ASSET_DELETE = true ────────────────────────────────────

  describe('when STORAGE_DELETE_ON_ASSET_DELETE is true', () => {
    beforeEach(() => {
      mockConfig.STORAGE_DELETE_ON_ASSET_DELETE = true;
    });

    it('calls storage.delete with the asset storage key', async () => {
      await deleteAsset(ASSET_ID.toHexString(), log);
      expect(mockStorage.delete).toHaveBeenCalledWith(READY_ASSET.storage!.key);
    });

    it('returns fileDeleted: true on success', async () => {
      const result = await deleteAsset(ASSET_ID.toHexString(), log);
      expect(result.fileDeleted).toBe(true);
    });

    it('returns fileDeleted: false when storage.delete throws', async () => {
      mockStorage.delete.mockRejectedValue(new Error('S3 permission denied'));
      const result = await deleteAsset(ASSET_ID.toHexString(), log);
      // Storage failure is non-fatal — soft-delete already committed
      expect(result.fileDeleted).toBe(false);
    });

    it('does not throw when storage.delete fails', async () => {
      mockStorage.delete.mockRejectedValue(new Error('Disk error'));
      await expect(deleteAsset(ASSET_ID.toHexString(), log)).resolves.toBeDefined();
    });

    it('does not call storage.delete when the asset has no storage key', async () => {
      mockFindAsset.mockResolvedValue(PENDING_ASSET); // no storage
      mockSoftDelete.mockResolvedValue({ ...PENDING_ASSET, deletedAt: new Date() });
      await deleteAsset(ASSET_ID.toHexString(), log);
      expect(mockStorage.delete).not.toHaveBeenCalled();
    });
  });
});
