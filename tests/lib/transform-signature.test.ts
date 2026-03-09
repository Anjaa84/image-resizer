import { describe, it, expect } from 'vitest';
import {
  computeTransformSignature,
  type TransformParams,
} from '../../src/lib/transform-signature';

// Baseline params reused across tests. Spread-override to vary one field at a time.
const BASE: TransformParams = {
  width:     800,
  height:    600,
  format:    'webp',
  quality:   85,
  fit:       'cover',
  rotate:    0,
  grayscale: false,
};

describe('computeTransformSignature', () => {
  // ─── Output format ─────────────────────────────────────────────────────────

  it('returns a 64-character lowercase hex string (SHA-256)', () => {
    const sig = computeTransformSignature(BASE);
    expect(sig).toMatch(/^[a-f0-9]{64}$/);
  });

  // ─── Determinism ───────────────────────────────────────────────────────────

  it('returns the same signature for the same params on repeated calls', () => {
    const sig1 = computeTransformSignature(BASE);
    const sig2 = computeTransformSignature({ ...BASE });
    expect(sig1).toBe(sig2);
  });

  // ─── Field-order stability ─────────────────────────────────────────────────

  it('produces the same signature regardless of JS object property order', () => {
    // Build the same logical params in a different insertion order.
    const reordered: TransformParams = {
      grayscale: BASE.grayscale,
      rotate:    BASE.rotate,
      quality:   BASE.quality,
      fit:       BASE.fit,
      format:    BASE.format,
      height:    BASE.height,
      width:     BASE.width,
    };
    expect(computeTransformSignature(BASE)).toBe(computeTransformSignature(reordered));
  });

  // ─── Sensitivity — each field change must change the signature ─────────────

  it('produces a different signature when width changes', () => {
    const sig1 = computeTransformSignature(BASE);
    const sig2 = computeTransformSignature({ ...BASE, width: 1920 });
    expect(sig1).not.toBe(sig2);
  });

  it('produces a different signature when height changes', () => {
    const sig1 = computeTransformSignature(BASE);
    const sig2 = computeTransformSignature({ ...BASE, height: 400 });
    expect(sig1).not.toBe(sig2);
  });

  it('produces a different signature when format changes', () => {
    const sig1 = computeTransformSignature(BASE);
    const sig2 = computeTransformSignature({ ...BASE, format: 'jpeg' });
    expect(sig1).not.toBe(sig2);
  });

  it('produces a different signature when quality changes', () => {
    const sig1 = computeTransformSignature(BASE);
    const sig2 = computeTransformSignature({ ...BASE, quality: 60 });
    expect(sig1).not.toBe(sig2);
  });

  it('produces a different signature when fit changes', () => {
    const sig1 = computeTransformSignature(BASE);
    const sig2 = computeTransformSignature({ ...BASE, fit: 'contain' });
    expect(sig1).not.toBe(sig2);
  });

  it('produces a different signature when rotate changes', () => {
    const sig1 = computeTransformSignature(BASE);
    const sig2 = computeTransformSignature({ ...BASE, rotate: 90 });
    expect(sig1).not.toBe(sig2);
  });

  it('produces a different signature when grayscale changes', () => {
    const sig1 = computeTransformSignature(BASE);
    const sig2 = computeTransformSignature({ ...BASE, grayscale: true });
    expect(sig1).not.toBe(sig2);
  });

  // ─── Stability — rotate: 0 and grayscale: false must not match rotate: 1 etc.

  it('treats rotate: 0 and rotate: 1 as distinct', () => {
    expect(computeTransformSignature({ ...BASE, rotate: 0 })).not.toBe(
      computeTransformSignature({ ...BASE, rotate: 1 }),
    );
  });

  it('treats grayscale: true and grayscale: false as distinct', () => {
    expect(computeTransformSignature({ ...BASE, grayscale: true })).not.toBe(
      computeTransformSignature({ ...BASE, grayscale: false }),
    );
  });

  // ─── All-field uniqueness ──────────────────────────────────────────────────

  it('produces unique signatures for all supported format values', () => {
    const formats = ['jpeg', 'png', 'webp', 'avif'] as const;
    const sigs = formats.map((format) => computeTransformSignature({ ...BASE, format }));
    const unique = new Set(sigs);
    expect(unique.size).toBe(formats.length);
  });

  it('produces unique signatures for all supported fit values', () => {
    const fits = ['cover', 'contain', 'fill', 'inside', 'outside'] as const;
    const sigs = fits.map((fit) => computeTransformSignature({ ...BASE, fit }));
    const unique = new Set(sigs);
    expect(unique.size).toBe(fits.length);
  });
});
