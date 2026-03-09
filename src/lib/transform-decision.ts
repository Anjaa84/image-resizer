/**
 * transform-decision — pure sync-vs-async routing logic.
 *
 * Decides whether an image transformation should be executed synchronously
 * (inline, within the API request handler) or asynchronously (offloaded to
 * the BullMQ worker pool).
 *
 * This module has zero I/O and zero side effects. It imports only types and
 * the config singleton. All decisions are deterministic given the same inputs
 * and config, which makes it straightforward to unit-test without mocking.
 *
 * ── Decision rules (evaluated in priority order) ──────────────────────────
 *
 *   1. Format rule   — certain output formats (AVIF) are unconditionally async
 *                      because their encoders are too CPU-intensive for inline
 *                      use. Checked first so a tiny AVIF request still routes
 *                      to the worker.
 *
 *   2. Source size   — large source files take longer to decode and saturate
 *                      memory. If sourceSizeBytes > syncMaxSourceBytes → async.
 *
 *   3. Output pixels — large output dimensions (width × height) consume more
 *                      memory and CPU during resize/encode. If outputPixels >
 *                      syncMaxOutputPixels → async.
 *
 *   4. Complexity    — each non-baseline operation (rotate, grayscale) adds 1
 *                      to the complexity score. If score > syncMaxComplexity
 *                      → async. Baseline resize always costs 0 (it is the
 *                      minimum operation and is already covered by the pixel
 *                      rule).
 *
 * A transform routes sync only when ALL four rules are satisfied.
 * The first failing rule wins; its message is the `reason` in the result.
 */

import { config } from '../config';
import type { IAssetTransform } from '../modules/images/asset.model';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ExecutionMode = 'sync' | 'async';

/**
 * Configurable thresholds for the sync/async decision.
 *
 * Pass an explicit `DecisionConfig` to `decideExecutionMode` in tests rather
 * than relying on the env-derived defaults. This keeps tests hermetic.
 */
export interface DecisionConfig {
  /** Maximum source file size (bytes) that qualifies for synchronous processing. */
  syncMaxSourceBytes: number;
  /** Maximum output pixel count (width × height) for synchronous processing. */
  syncMaxOutputPixels: number;
  /**
   * Maximum complexity score for synchronous processing.
   * Score = (rotate ≠ 0 ? 1 : 0) + (grayscale ? 1 : 0).
   */
  syncMaxComplexity: number;
  /**
   * Output formats that always route async regardless of other thresholds.
   * Default: ['avif'] — the AV1 encoder is 10–100× slower than JPEG/WebP.
   */
  asyncFormats: ReadonlyArray<IAssetTransform['format']>;
}

export interface DecisionResult {
  mode: ExecutionMode;
  /** Numeric score of non-baseline transform operations (0–2). */
  complexityScore: number;
  /** Human-readable explanation of the decision, for structured logging. */
  reason: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Computes the complexity score for a set of transform parameters.
 *
 * Baseline resize (width/height) is not counted — its cost is captured by the
 * output-pixel rule. Each additional operation adds 1:
 *   - rotate (any non-zero angle): +1  (expand-then-crop geometry pass)
 *   - grayscale: +1                    (extra colour-space conversion)
 *
 * Maximum score is 2 (both rotate and grayscale applied simultaneously).
 *
 * Exported so it can be tested directly and used by callers that want to
 * surface the score without running the full decision.
 */
export function computeComplexityScore(
  transform: Pick<IAssetTransform, 'rotate' | 'grayscale'>,
): number {
  return (transform.rotate !== 0 ? 1 : 0) + (transform.grayscale ? 1 : 0);
}

/**
 * Builds the default `DecisionConfig` from the application env config.
 *
 * This is NOT exported intentionally — callers should either accept the
 * default (by omitting the second argument) or pass an explicit config
 * override. Tests always pass an explicit config to stay decoupled from
 * environment variables.
 */
function buildDefaultConfig(): DecisionConfig {
  return {
    syncMaxSourceBytes:  config.SYNC_MAX_SOURCE_BYTES,
    syncMaxOutputPixels: config.SYNC_MAX_OUTPUT_PIXELS,
    syncMaxComplexity:   config.SYNC_MAX_COMPLEXITY,
    asyncFormats:        ['avif'],
  };
}

// ─── Decision ─────────────────────────────────────────────────────────────────

/**
 * Determines the execution mode for an image transformation.
 *
 * @param params.sourceSizeBytes  Byte length of the source (original) image.
 * @param params.transform        The resolved transform parameters.
 * @param cfg                     Optional config override; defaults to env-
 *                                derived thresholds. Always pass an explicit
 *                                value in tests.
 */
export function decideExecutionMode(
  params: {
    sourceSizeBytes: number;
    transform: IAssetTransform;
  },
  cfg: DecisionConfig = buildDefaultConfig(),
): DecisionResult {
  const { sourceSizeBytes, transform } = params;
  const complexityScore = computeComplexityScore(transform);
  const outputPixels    = transform.width * transform.height;

  // Rule 1 — format (unconditional; checked before numeric thresholds)
  if (cfg.asyncFormats.includes(transform.format)) {
    return {
      mode: 'async',
      complexityScore,
      reason: `format '${transform.format}' is always async`,
    };
  }

  // Rule 2 — source file size
  if (sourceSizeBytes > cfg.syncMaxSourceBytes) {
    return {
      mode: 'async',
      complexityScore,
      reason:
        `sourceSizeBytes ${sourceSizeBytes} exceeds syncMaxSourceBytes ${cfg.syncMaxSourceBytes}`,
    };
  }

  // Rule 3 — output pixel count
  if (outputPixels > cfg.syncMaxOutputPixels) {
    return {
      mode: 'async',
      complexityScore,
      reason:
        `outputPixels ${outputPixels} (${transform.width}×${transform.height}) ` +
        `exceeds syncMaxOutputPixels ${cfg.syncMaxOutputPixels}`,
    };
  }

  // Rule 4 — transform complexity
  if (complexityScore > cfg.syncMaxComplexity) {
    return {
      mode: 'async',
      complexityScore,
      reason:
        `complexityScore ${complexityScore} exceeds syncMaxComplexity ${cfg.syncMaxComplexity}`,
    };
  }

  return {
    mode: 'sync',
    complexityScore,
    reason: 'all thresholds within sync limits',
  };
}
