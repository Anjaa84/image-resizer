/**
 * Tests for src/modules/images/transform.service.ts
 *
 * Strategy: unit-test the orchestration layer in isolation.
 * - Repository (findOrCreateDerivedAsset) is mocked — we verify that the
 *   service wires the repository return value to the result correctly, and
 *   that dedup vs new-asset paths diverge as expected.
 * - decideExecutionMode is mocked — we verify that it is called with the
 *   correct inputs and that its return value flows into the result. We do NOT
 *   retest the decision logic here; that is covered in transform-decision.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Types } from 'mongoose';
import type { FastifyBaseLogger } from 'fastify';
import type { IAssetTransform, LeanAsset } from '../../../src/modules/images/asset.model';
import type { DecisionResult } from '../../../src/lib/transform-decision';

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('../../../src/modules/images/asset.repository', () => ({
  findOrCreateDerivedAsset: vi.fn(),
  // Other exports kept as no-ops to satisfy any transitive imports
  findAssetById:     vi.fn(),
  findOriginalByHash: vi.fn(),
  createOriginalAsset: vi.fn(),
  updateAssetStatus:  vi.fn(),
  softDeleteAsset:    vi.fn(),
  listAssets:         vi.fn(),
}));

vi.mock('../../../src/lib/transform-decision', () => ({
  decideExecutionMode: vi.fn(),
  // computeComplexityScore is not called by the service — keep as stub
  computeComplexityScore: vi.fn(),
}));

// ─── Lazy imports (after mocks) ───────────────────────────────────────────────

const { resolveTransform } =
  await import('../../../src/modules/images/transform.service');
const { findOrCreateDerivedAsset } =
  await import('../../../src/modules/images/asset.repository');
const { decideExecutionMode } =
  await import('../../../src/lib/transform-decision');

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_ASSET: LeanAsset = {
  _id:       { toString: () => '507f1f77bcf86cd799439011' } as unknown as Types.ObjectId,
  type:      'derived',
  status:    'pending',
  createdAt: new Date('2024-01-01T00:00:00.000Z'),
  updatedAt: new Date('2024-01-01T00:00:00.000Z'),
};

const BASE_TRANSFORM: IAssetTransform = {
  width:     800,
  height:    600,
  format:    'webp',
  quality:   85,
  fit:       'cover',
  rotate:    0,
  grayscale: false,
};

const MOCK_SOURCE_ID = {
  toString: () => 'aabbccddeeff001122334455',
} as unknown as Types.ObjectId;

const BASE_PARAMS = {
  sourceAssetId:   MOCK_SOURCE_ID,
  sourceSizeBytes: 500_000,
  transform:       BASE_TRANSFORM,
};

const SYNC_DECISION: DecisionResult = {
  mode:            'sync',
  complexityScore: 0,
  reason:          'all thresholds within sync limits',
};

const ASYNC_DECISION: DecisionResult = {
  mode:            'async',
  complexityScore: 2,
  reason:          "complexityScore 2 exceeds syncMaxComplexity 1",
};

/** A minimal no-op logger that prevents Pino noise in test output. */
const mockLog = {
  info:  vi.fn(),
  warn:  vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(),
} as unknown as FastifyBaseLogger;

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // Default: new asset created, sync decision
  vi.mocked(findOrCreateDerivedAsset).mockResolvedValue({ asset: MOCK_ASSET, created: true });
  vi.mocked(decideExecutionMode).mockReturnValue(SYNC_DECISION);
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('resolveTransform', () => {

  // ── Repository integration ─────────────────────────────────────────────────

  describe('repository call', () => {
    it('calls findOrCreateDerivedAsset with the correct sourceAssetId', async () => {
      await resolveTransform(BASE_PARAMS, mockLog);

      const [input] = vi.mocked(findOrCreateDerivedAsset).mock.calls[0]!;
      expect(input.sourceAssetId).toBe(MOCK_SOURCE_ID);
    });

    it('calls findOrCreateDerivedAsset with the correct transform', async () => {
      await resolveTransform(BASE_PARAMS, mockLog);

      const [input] = vi.mocked(findOrCreateDerivedAsset).mock.calls[0]!;
      expect(input.transform).toEqual(BASE_TRANSFORM);
    });

    it('calls findOrCreateDerivedAsset exactly once', async () => {
      await resolveTransform(BASE_PARAMS, mockLog);
      expect(findOrCreateDerivedAsset).toHaveBeenCalledOnce();
    });
  });

  // ── Deduplication hit (created: false) ────────────────────────────────────

  describe('dedup hit — created: false', () => {
    beforeEach(() => {
      vi.mocked(findOrCreateDerivedAsset).mockResolvedValue({
        asset: MOCK_ASSET,
        created: false,
      });
    });

    it('returns isDuplicate: true', async () => {
      const result = await resolveTransform(BASE_PARAMS, mockLog);
      expect(result.isDuplicate).toBe(true);
    });

    it('returns the asset from the repository', async () => {
      const result = await resolveTransform(BASE_PARAMS, mockLog);
      expect(result.asset).toBe(MOCK_ASSET);
    });

    it('does NOT call decideExecutionMode', async () => {
      await resolveTransform(BASE_PARAMS, mockLog);
      expect(decideExecutionMode).not.toHaveBeenCalled();
    });

    it('result does not have executionMode', async () => {
      const result = await resolveTransform(BASE_PARAMS, mockLog);
      // Use type narrowing — on the isDuplicate: true branch, executionMode is absent
      if (result.isDuplicate) {
        // @ts-expect-error — executionMode must not exist on this branch
        expect(result.executionMode).toBeUndefined();
      }
    });

    it('result does not have decision', async () => {
      const result = await resolveTransform(BASE_PARAMS, mockLog);
      if (result.isDuplicate) {
        // @ts-expect-error — decision must not exist on this branch
        expect(result.decision).toBeUndefined();
      }
    });

    it('works for a deduplicated asset in ready status', async () => {
      const readyAsset = { ...MOCK_ASSET, status: 'ready' as const };
      vi.mocked(findOrCreateDerivedAsset).mockResolvedValue({
        asset: readyAsset as LeanAsset,
        created: false,
      });

      const result = await resolveTransform(BASE_PARAMS, mockLog);
      expect(result.isDuplicate).toBe(true);
      expect(result.asset.status).toBe('ready');
    });

    it('works for a deduplicated asset in processing status', async () => {
      const processingAsset = { ...MOCK_ASSET, status: 'processing' as const };
      vi.mocked(findOrCreateDerivedAsset).mockResolvedValue({
        asset: processingAsset as LeanAsset,
        created: false,
      });

      const result = await resolveTransform(BASE_PARAMS, mockLog);
      expect(result.isDuplicate).toBe(true);
      expect(result.asset.status).toBe('processing');
    });
  });

  // ── New asset (created: true) ─────────────────────────────────────────────

  describe('new asset — created: true', () => {
    it('returns isDuplicate: false', async () => {
      const result = await resolveTransform(BASE_PARAMS, mockLog);
      expect(result.isDuplicate).toBe(false);
    });

    it('returns the asset from the repository', async () => {
      const result = await resolveTransform(BASE_PARAMS, mockLog);
      expect(result.asset).toBe(MOCK_ASSET);
    });

    it('calls decideExecutionMode exactly once', async () => {
      await resolveTransform(BASE_PARAMS, mockLog);
      expect(decideExecutionMode).toHaveBeenCalledOnce();
    });

    it('passes sourceSizeBytes to decideExecutionMode', async () => {
      await resolveTransform(BASE_PARAMS, mockLog);

      const [params] = vi.mocked(decideExecutionMode).mock.calls[0]!;
      expect(params.sourceSizeBytes).toBe(BASE_PARAMS.sourceSizeBytes);
    });

    it('passes the transform to decideExecutionMode', async () => {
      await resolveTransform(BASE_PARAMS, mockLog);

      const [params] = vi.mocked(decideExecutionMode).mock.calls[0]!;
      expect(params.transform).toEqual(BASE_TRANSFORM);
    });

    it('includes executionMode from the decision result', async () => {
      const result = await resolveTransform(BASE_PARAMS, mockLog);

      if (!result.isDuplicate) {
        expect(result.executionMode).toBe(SYNC_DECISION.mode);
      }
    });

    it('includes the full decision object in the result', async () => {
      const result = await resolveTransform(BASE_PARAMS, mockLog);

      if (!result.isDuplicate) {
        expect(result.decision).toBe(SYNC_DECISION);
      }
    });
  });

  // ── Sync execution mode ───────────────────────────────────────────────────

  describe('sync execution mode', () => {
    it('result.executionMode is "sync" when decideExecutionMode returns sync', async () => {
      vi.mocked(decideExecutionMode).mockReturnValue(SYNC_DECISION);

      const result = await resolveTransform(BASE_PARAMS, mockLog);

      if (!result.isDuplicate) {
        expect(result.executionMode).toBe('sync');
      } else {
        throw new Error('Expected a new asset, not a duplicate');
      }
    });
  });

  // ── Async execution mode ──────────────────────────────────────────────────

  describe('async execution mode', () => {
    it('result.executionMode is "async" when decideExecutionMode returns async', async () => {
      vi.mocked(decideExecutionMode).mockReturnValue(ASYNC_DECISION);

      const result = await resolveTransform(BASE_PARAMS, mockLog);

      if (!result.isDuplicate) {
        expect(result.executionMode).toBe('async');
        expect(result.decision.reason).toContain('complexityScore');
      } else {
        throw new Error('Expected a new asset, not a duplicate');
      }
    });
  });

  // ── Decision config forwarding ─────────────────────────────────────────────

  describe('decision config forwarding', () => {
    it('passes the decisionConfig override to decideExecutionMode', async () => {
      const customCfg = {
        syncMaxSourceBytes:  1,
        syncMaxOutputPixels: 1,
        syncMaxComplexity:   0,
        asyncFormats:        ['avif'] as const,
      };

      await resolveTransform(BASE_PARAMS, mockLog, customCfg);

      const [, passedCfg] = vi.mocked(decideExecutionMode).mock.calls[0]!;
      expect(passedCfg).toBe(customCfg);
    });

    it('passes undefined config when no override is given (lets service use its own default)', async () => {
      await resolveTransform(BASE_PARAMS, mockLog);

      const [, passedCfg] = vi.mocked(decideExecutionMode).mock.calls[0]!;
      expect(passedCfg).toBeUndefined();
    });
  });
});
