import { describe, it, expect } from 'vitest';
import { ZodError } from 'zod';
import { transformOptionsSchema } from '../../src/lib/transform-options';

describe('transformOptionsSchema', () => {
  // ─── Defaults ───────────────────────────────────────────────────────────────

  it('applies all defaults when no options are provided', () => {
    const result = transformOptionsSchema.parse({});
    expect(result).toEqual({
      width:     undefined,
      height:    undefined,
      format:    'webp',
      quality:   85,
      fit:       'cover',
      rotate:    0,
      grayscale: false,
    });
  });

  // ─── Valid full input ────────────────────────────────────────────────────────

  it('accepts a fully-specified valid options object', () => {
    const result = transformOptionsSchema.parse({
      width:     800,
      height:    600,
      format:    'jpeg',
      quality:   75,
      fit:       'contain',
      rotate:    90,
      grayscale: true,
    });
    expect(result).toEqual({
      width:     800,
      height:    600,
      format:    'jpeg',
      quality:   75,
      fit:       'contain',
      rotate:    90,
      grayscale: true,
    });
  });

  // ─── Width / Height ──────────────────────────────────────────────────────────

  it('accepts only width (height is optional)', () => {
    const result = transformOptionsSchema.parse({ width: 1920 });
    expect(result.width).toBe(1920);
    expect(result.height).toBeUndefined();
  });

  it('accepts only height (width is optional)', () => {
    const result = transformOptionsSchema.parse({ height: 1080 });
    expect(result.height).toBe(1080);
    expect(result.width).toBeUndefined();
  });

  it('rejects width of 0', () => {
    expect(() => transformOptionsSchema.parse({ width: 0 })).toThrow(ZodError);
  });

  it('rejects negative width', () => {
    expect(() => transformOptionsSchema.parse({ width: -1 })).toThrow(ZodError);
  });

  it('rejects width exceeding 10,000', () => {
    expect(() => transformOptionsSchema.parse({ width: 10_001 })).toThrow(ZodError);
  });

  it('rejects non-integer width', () => {
    expect(() => transformOptionsSchema.parse({ width: 800.5 })).toThrow(ZodError);
  });

  it('accepts maximum allowed dimensions (10,000 × 10,000)', () => {
    const result = transformOptionsSchema.parse({ width: 10_000, height: 10_000 });
    expect(result.width).toBe(10_000);
    expect(result.height).toBe(10_000);
  });

  // ─── Format ─────────────────────────────────────────────────────────────────

  it('accepts all valid format values', () => {
    for (const format of ['jpeg', 'png', 'webp', 'avif'] as const) {
      const result = transformOptionsSchema.parse({ format });
      expect(result.format).toBe(format);
    }
  });

  it('rejects unknown format', () => {
    expect(() => transformOptionsSchema.parse({ format: 'gif' })).toThrow(ZodError);
  });

  it('defaults format to webp', () => {
    const result = transformOptionsSchema.parse({});
    expect(result.format).toBe('webp');
  });

  // ─── Quality ─────────────────────────────────────────────────────────────────

  it('accepts quality 1 (minimum)', () => {
    const result = transformOptionsSchema.parse({ quality: 1 });
    expect(result.quality).toBe(1);
  });

  it('accepts quality 100 (maximum)', () => {
    const result = transformOptionsSchema.parse({ quality: 100 });
    expect(result.quality).toBe(100);
  });

  it('rejects quality 0', () => {
    expect(() => transformOptionsSchema.parse({ quality: 0 })).toThrow(ZodError);
  });

  it('rejects quality 101', () => {
    expect(() => transformOptionsSchema.parse({ quality: 101 })).toThrow(ZodError);
  });

  it('rejects non-integer quality', () => {
    expect(() => transformOptionsSchema.parse({ quality: 85.5 })).toThrow(ZodError);
  });

  it('defaults quality to 85', () => {
    const result = transformOptionsSchema.parse({});
    expect(result.quality).toBe(85);
  });

  // ─── Fit ─────────────────────────────────────────────────────────────────────

  it('accepts all valid fit values', () => {
    for (const fit of ['cover', 'contain', 'fill', 'inside', 'outside'] as const) {
      const result = transformOptionsSchema.parse({ fit });
      expect(result.fit).toBe(fit);
    }
  });

  it('rejects unknown fit value', () => {
    expect(() => transformOptionsSchema.parse({ fit: 'stretch' })).toThrow(ZodError);
  });

  it('defaults fit to cover', () => {
    const result = transformOptionsSchema.parse({});
    expect(result.fit).toBe('cover');
  });

  // ─── Rotate ──────────────────────────────────────────────────────────────────

  it('accepts rotate 0 (no rotation)', () => {
    const result = transformOptionsSchema.parse({ rotate: 0 });
    expect(result.rotate).toBe(0);
  });

  it('accepts positive rotation up to 360', () => {
    const result = transformOptionsSchema.parse({ rotate: 360 });
    expect(result.rotate).toBe(360);
  });

  it('accepts negative rotation down to -360', () => {
    const result = transformOptionsSchema.parse({ rotate: -360 });
    expect(result.rotate).toBe(-360);
  });

  it('rejects rotation > 360', () => {
    expect(() => transformOptionsSchema.parse({ rotate: 361 })).toThrow(ZodError);
  });

  it('rejects rotation < -360', () => {
    expect(() => transformOptionsSchema.parse({ rotate: -361 })).toThrow(ZodError);
  });

  it('rejects non-integer rotation', () => {
    expect(() => transformOptionsSchema.parse({ rotate: 45.5 })).toThrow(ZodError);
  });

  it('defaults rotate to 0', () => {
    const result = transformOptionsSchema.parse({});
    expect(result.rotate).toBe(0);
  });

  // ─── Grayscale ────────────────────────────────────────────────────────────────

  it('accepts grayscale: true', () => {
    const result = transformOptionsSchema.parse({ grayscale: true });
    expect(result.grayscale).toBe(true);
  });

  it('accepts grayscale: false', () => {
    const result = transformOptionsSchema.parse({ grayscale: false });
    expect(result.grayscale).toBe(false);
  });

  it('rejects non-boolean grayscale', () => {
    expect(() => transformOptionsSchema.parse({ grayscale: 'yes' })).toThrow(ZodError);
  });

  it('defaults grayscale to false', () => {
    const result = transformOptionsSchema.parse({});
    expect(result.grayscale).toBe(false);
  });
});
