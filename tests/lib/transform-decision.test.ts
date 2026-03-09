/**
 * Tests for src/lib/transform-decision.ts
 *
 * Pure-function tests — no mocking needed. Every test passes explicit
 * DecisionConfig values so results are deterministic regardless of env vars.
 */
import { describe, it, expect } from 'vitest';
import {
  computeComplexityScore,
  decideExecutionMode,
  type DecisionConfig,
  type IAssetTransform,
} from '../../src/lib/transform-decision';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/**
 * A complete IAssetTransform that satisfies all sync thresholds under BASE_CFG.
 * Override individual fields with spread to test specific rules.
 */
const BASE_TRANSFORM: IAssetTransform = {
  width:     1920,
  height:    1080,
  format:    'webp',
  quality:   85,
  fit:       'cover',
  rotate:    0,
  grayscale: false,
};

/**
 * Known-value config used by all tests. Using explicit values (not env-derived
 * defaults) keeps every assertion free of external state.
 *
 *   syncMaxSourceBytes  = 1 MB  (1_048_576)
 *   syncMaxOutputPixels = 1920×1080 (2_073_600) — BASE_TRANSFORM is exactly at boundary
 *   syncMaxComplexity   = 1
 *   asyncFormats        = ['avif']
 */
const BASE_CFG: DecisionConfig = {
  syncMaxSourceBytes:  1_048_576,
  syncMaxOutputPixels: 2_073_600,
  syncMaxComplexity:   1,
  asyncFormats:        ['avif'],
};

const SMALL_SOURCE  = 500_000;   // 500 KB  — safely within syncMaxSourceBytes
const LARGE_SOURCE  = 2_000_000; // 2 MB    — exceeds syncMaxSourceBytes

// ─── computeComplexityScore ───────────────────────────────────────────────────

describe('computeComplexityScore', () => {
  it('returns 0 when rotate is 0 and grayscale is false', () => {
    expect(computeComplexityScore({ rotate: 0, grayscale: false })).toBe(0);
  });

  it('returns 1 when rotate is non-zero and grayscale is false', () => {
    expect(computeComplexityScore({ rotate: 90, grayscale: false })).toBe(1);
  });

  it('returns 1 when rotate is 0 and grayscale is true', () => {
    expect(computeComplexityScore({ rotate: 0, grayscale: true })).toBe(1);
  });

  it('returns 2 when both rotate is non-zero and grayscale is true', () => {
    expect(computeComplexityScore({ rotate: -45, grayscale: true })).toBe(2);
  });

  it('treats positive and negative rotation the same (non-zero = +1)', () => {
    expect(computeComplexityScore({ rotate: 180, grayscale: false }))
      .toBe(computeComplexityScore({ rotate: -180, grayscale: false }));
  });
});

// ─── decideExecutionMode ──────────────────────────────────────────────────────

describe('decideExecutionMode', () => {

  // ── Result structure ────────────────────────────────────────────────────────

  describe('result structure', () => {
    it('always includes complexityScore in the result', () => {
      const result = decideExecutionMode(
        { sourceSizeBytes: SMALL_SOURCE, transform: BASE_TRANSFORM },
        BASE_CFG,
      );
      expect(result.complexityScore).toBeDefined();
      expect(typeof result.complexityScore).toBe('number');
    });

    it('always includes a non-empty reason string', () => {
      const result = decideExecutionMode(
        { sourceSizeBytes: SMALL_SOURCE, transform: BASE_TRANSFORM },
        BASE_CFG,
      );
      expect(typeof result.reason).toBe('string');
      expect(result.reason.length).toBeGreaterThan(0);
    });
  });

  // ── Sync baseline ───────────────────────────────────────────────────────────

  describe('sync baseline', () => {
    it('returns sync when all thresholds are satisfied', () => {
      const result = decideExecutionMode(
        { sourceSizeBytes: SMALL_SOURCE, transform: BASE_TRANSFORM },
        BASE_CFG,
      );
      expect(result.mode).toBe('sync');
    });

    it('reason is the affirmative "all thresholds within sync limits" string', () => {
      const result = decideExecutionMode(
        { sourceSizeBytes: SMALL_SOURCE, transform: BASE_TRANSFORM },
        BASE_CFG,
      );
      expect(result.reason).toBe('all thresholds within sync limits');
    });

    it('complexityScore is 0 for a basic resize with no extras', () => {
      const result = decideExecutionMode(
        { sourceSizeBytes: SMALL_SOURCE, transform: BASE_TRANSFORM },
        BASE_CFG,
      );
      expect(result.complexityScore).toBe(0);
    });
  });

  // ── Rule 1: format ─────────────────────────────────────────────────────────

  describe('Rule 1 — format', () => {
    it('returns async for avif even when source is tiny', () => {
      const result = decideExecutionMode(
        {
          sourceSizeBytes: 1,  // absurdly small — still async
          transform: { ...BASE_TRANSFORM, format: 'avif', width: 1, height: 1 },
        },
        BASE_CFG,
      );
      expect(result.mode).toBe('async');
    });

    it('reason mentions the format name', () => {
      const result = decideExecutionMode(
        { sourceSizeBytes: SMALL_SOURCE, transform: { ...BASE_TRANSFORM, format: 'avif' } },
        BASE_CFG,
      );
      expect(result.reason).toContain('avif');
    });

    it('returns sync for jpeg (not in asyncFormats)', () => {
      const result = decideExecutionMode(
        { sourceSizeBytes: SMALL_SOURCE, transform: { ...BASE_TRANSFORM, format: 'jpeg' } },
        BASE_CFG,
      );
      expect(result.mode).toBe('sync');
    });

    it('returns sync for png', () => {
      const result = decideExecutionMode(
        { sourceSizeBytes: SMALL_SOURCE, transform: { ...BASE_TRANSFORM, format: 'png' } },
        BASE_CFG,
      );
      expect(result.mode).toBe('sync');
    });

    it('returns sync for webp', () => {
      const result = decideExecutionMode(
        { sourceSizeBytes: SMALL_SOURCE, transform: { ...BASE_TRANSFORM, format: 'webp' } },
        BASE_CFG,
      );
      expect(result.mode).toBe('sync');
    });

    it('allows asyncFormats to be overridden via config', () => {
      // Config that makes jpeg async and leaves avif sync
      const customCfg: DecisionConfig = { ...BASE_CFG, asyncFormats: ['jpeg'] };

      const jpegResult = decideExecutionMode(
        { sourceSizeBytes: SMALL_SOURCE, transform: { ...BASE_TRANSFORM, format: 'jpeg' } },
        customCfg,
      );
      expect(jpegResult.mode).toBe('async');

      const avifResult = decideExecutionMode(
        { sourceSizeBytes: SMALL_SOURCE, transform: { ...BASE_TRANSFORM, format: 'avif', width: 100, height: 100 } },
        customCfg,
      );
      expect(avifResult.mode).toBe('sync');
    });
  });

  // ── Rule 2: source size ────────────────────────────────────────────────────

  describe('Rule 2 — source size', () => {
    it('returns async when sourceSizeBytes exceeds syncMaxSourceBytes', () => {
      const result = decideExecutionMode(
        { sourceSizeBytes: LARGE_SOURCE, transform: BASE_TRANSFORM },
        BASE_CFG,
      );
      expect(result.mode).toBe('async');
    });

    it('reason mentions sourceSizeBytes and syncMaxSourceBytes', () => {
      const result = decideExecutionMode(
        { sourceSizeBytes: LARGE_SOURCE, transform: BASE_TRANSFORM },
        BASE_CFG,
      );
      expect(result.reason).toContain('sourceSizeBytes');
      expect(result.reason).toContain(String(LARGE_SOURCE));
      expect(result.reason).toContain(String(BASE_CFG.syncMaxSourceBytes));
    });

    it('returns sync at exactly syncMaxSourceBytes (boundary — not exceeded)', () => {
      const result = decideExecutionMode(
        { sourceSizeBytes: BASE_CFG.syncMaxSourceBytes, transform: BASE_TRANSFORM },
        BASE_CFG,
      );
      expect(result.mode).toBe('sync');
    });

    it('returns async at syncMaxSourceBytes + 1', () => {
      const result = decideExecutionMode(
        { sourceSizeBytes: BASE_CFG.syncMaxSourceBytes + 1, transform: BASE_TRANSFORM },
        BASE_CFG,
      );
      expect(result.mode).toBe('async');
    });

    it('syncMaxSourceBytes threshold is configurable', () => {
      const tightCfg: DecisionConfig = { ...BASE_CFG, syncMaxSourceBytes: 100 };
      const result = decideExecutionMode(
        { sourceSizeBytes: 101, transform: BASE_TRANSFORM },
        tightCfg,
      );
      expect(result.mode).toBe('async');
    });
  });

  // ── Rule 3: output pixels ──────────────────────────────────────────────────

  describe('Rule 3 — output pixels', () => {
    it('returns async when width × height exceeds syncMaxOutputPixels', () => {
      // 4K: 3840×2160 = 8,294,400 pixels > 2,073,600
      const result = decideExecutionMode(
        {
          sourceSizeBytes: SMALL_SOURCE,
          transform: { ...BASE_TRANSFORM, width: 3840, height: 2160 },
        },
        BASE_CFG,
      );
      expect(result.mode).toBe('async');
    });

    it('reason mentions outputPixels and the dimensions', () => {
      const result = decideExecutionMode(
        {
          sourceSizeBytes: SMALL_SOURCE,
          transform: { ...BASE_TRANSFORM, width: 3840, height: 2160 },
        },
        BASE_CFG,
      );
      expect(result.reason).toContain('outputPixels');
      expect(result.reason).toContain('3840');
      expect(result.reason).toContain('2160');
    });

    it('returns sync at exactly syncMaxOutputPixels (boundary)', () => {
      // 1920×1080 = 2,073,600 — exactly at the threshold
      const result = decideExecutionMode(
        {
          sourceSizeBytes: SMALL_SOURCE,
          transform: { ...BASE_TRANSFORM, width: 1920, height: 1080 },
        },
        BASE_CFG,
      );
      expect(result.mode).toBe('sync');
    });

    it('returns async when pixels exceed threshold by just 1', () => {
      // 1921×1080 = 2,074,680 > 2,073,600
      const result = decideExecutionMode(
        {
          sourceSizeBytes: SMALL_SOURCE,
          transform: { ...BASE_TRANSFORM, width: 1921, height: 1080 },
        },
        BASE_CFG,
      );
      expect(result.mode).toBe('async');
    });

    it('syncMaxOutputPixels threshold is configurable', () => {
      const tightCfg: DecisionConfig = { ...BASE_CFG, syncMaxOutputPixels: 100 * 100 };
      const result = decideExecutionMode(
        {
          sourceSizeBytes: SMALL_SOURCE,
          transform: { ...BASE_TRANSFORM, width: 101, height: 100 },
        },
        tightCfg,
      );
      expect(result.mode).toBe('async');
    });
  });

  // ── Rule 4: complexity ─────────────────────────────────────────────────────

  describe('Rule 4 — complexity', () => {
    it('returns async when complexityScore exceeds syncMaxComplexity', () => {
      // rotate + grayscale = score 2 > syncMaxComplexity 1
      const result = decideExecutionMode(
        {
          sourceSizeBytes: SMALL_SOURCE,
          transform: { ...BASE_TRANSFORM, rotate: 90, grayscale: true },
        },
        BASE_CFG,
      );
      expect(result.mode).toBe('async');
    });

    it('reason mentions complexityScore and syncMaxComplexity', () => {
      const result = decideExecutionMode(
        {
          sourceSizeBytes: SMALL_SOURCE,
          transform: { ...BASE_TRANSFORM, rotate: 90, grayscale: true },
        },
        BASE_CFG,
      );
      expect(result.reason).toContain('complexityScore');
      expect(result.reason).toContain('2');
      expect(result.reason).toContain(String(BASE_CFG.syncMaxComplexity));
    });

    it('returns sync when complexityScore equals syncMaxComplexity (boundary)', () => {
      // grayscale-only = score 1 = syncMaxComplexity 1
      const result = decideExecutionMode(
        {
          sourceSizeBytes: SMALL_SOURCE,
          transform: { ...BASE_TRANSFORM, grayscale: true },
        },
        BASE_CFG,
      );
      expect(result.mode).toBe('sync');
    });

    it('returns sync for rotate-only (score 1 ≤ syncMaxComplexity 1)', () => {
      const result = decideExecutionMode(
        {
          sourceSizeBytes: SMALL_SOURCE,
          transform: { ...BASE_TRANSFORM, rotate: 45 },
        },
        BASE_CFG,
      );
      expect(result.mode).toBe('sync');
    });

    it('syncMaxComplexity 0 makes any extra operation async', () => {
      const strictCfg: DecisionConfig = { ...BASE_CFG, syncMaxComplexity: 0 };
      const result = decideExecutionMode(
        {
          sourceSizeBytes: SMALL_SOURCE,
          transform: { ...BASE_TRANSFORM, grayscale: true },
        },
        strictCfg,
      );
      expect(result.mode).toBe('async');
    });

    it('complexityScore in result matches computeComplexityScore', () => {
      const transform = { ...BASE_TRANSFORM, rotate: 90, grayscale: true };
      const expected  = computeComplexityScore(transform);
      const result    = decideExecutionMode({ sourceSizeBytes: SMALL_SOURCE, transform }, BASE_CFG);
      expect(result.complexityScore).toBe(expected);
    });
  });

  // ── Rule priority ──────────────────────────────────────────────────────────

  describe('rule priority', () => {
    it('format rule fires before size rule (avif + large source → format reason)', () => {
      const result = decideExecutionMode(
        {
          sourceSizeBytes: LARGE_SOURCE,  // would also trigger size rule
          transform: { ...BASE_TRANSFORM, format: 'avif' },
        },
        BASE_CFG,
      );
      // Reason must be the format rule, not the size rule
      expect(result.reason).toContain('avif');
      expect(result.reason).not.toContain('sourceSizeBytes');
    });

    it('format rule fires before pixel rule (avif + huge dimensions → format reason)', () => {
      const result = decideExecutionMode(
        {
          sourceSizeBytes: SMALL_SOURCE,
          transform: { ...BASE_TRANSFORM, format: 'avif', width: 4096, height: 4096 },
        },
        BASE_CFG,
      );
      expect(result.reason).toContain('avif');
      expect(result.reason).not.toContain('outputPixels');
    });

    it('format rule fires before complexity rule', () => {
      const result = decideExecutionMode(
        {
          sourceSizeBytes: SMALL_SOURCE,
          transform: { ...BASE_TRANSFORM, format: 'avif', rotate: 90, grayscale: true },
        },
        BASE_CFG,
      );
      expect(result.reason).toContain('avif');
      expect(result.reason).not.toContain('complexityScore');
    });

    it('size rule fires before pixel rule (large source + large dims → size reason)', () => {
      const result = decideExecutionMode(
        {
          sourceSizeBytes: LARGE_SOURCE,
          transform: { ...BASE_TRANSFORM, width: 4096, height: 4096 },
        },
        BASE_CFG,
      );
      expect(result.reason).toContain('sourceSizeBytes');
      expect(result.reason).not.toContain('outputPixels');
    });

    it('size rule fires before complexity rule', () => {
      const result = decideExecutionMode(
        {
          sourceSizeBytes: LARGE_SOURCE,
          transform: { ...BASE_TRANSFORM, rotate: 90, grayscale: true },
        },
        BASE_CFG,
      );
      expect(result.reason).toContain('sourceSizeBytes');
      expect(result.reason).not.toContain('complexityScore');
    });

    it('pixel rule fires before complexity rule', () => {
      const result = decideExecutionMode(
        {
          sourceSizeBytes: SMALL_SOURCE,
          transform: { ...BASE_TRANSFORM, width: 4096, height: 4096, rotate: 90, grayscale: true },
        },
        BASE_CFG,
      );
      expect(result.reason).toContain('outputPixels');
      expect(result.reason).not.toContain('complexityScore');
    });
  });
});
