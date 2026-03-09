import sharp from 'sharp';
import { transformOptionsSchema, type TransformOptions, type TransformOptionsInput } from './transform-options';

/**
 * Result returned after a successful image transformation.
 *
 * `buffer`   — the processed image bytes, ready for storage.
 * `mimeType` — the actual MIME type of the output (based on the format param).
 * `width`    — pixel width of the output image.
 * `height`   — pixel height of the output image.
 * `sizeBytes` — byte length of the output buffer.
 */
export interface ProcessingResult {
  buffer: Buffer;
  mimeType: string;
  width: number;
  height: number;
  sizeBytes: number;
}

const FORMAT_MIME: Record<TransformOptions['format'], string> = {
  jpeg: 'image/jpeg',
  png:  'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
};

/**
 * Validates raw transform options against the schema.
 *
 * Separating validation from processing allows callers to surface validation
 * errors before doing any I/O (reading the source file from storage).
 *
 * @throws `ZodError` if validation fails.
 */
export function validateTransformOptions(raw: TransformOptionsInput): TransformOptions {
  return transformOptionsSchema.parse(raw);
}

/**
 * Applies image transformations to a source image using Sharp.
 *
 * Pipeline order is significant:
 *   1. rotate  — must come first so resize operates on the correctly-oriented image
 *   2. resize  — applies dimensions and fit mode
 *   3. grayscale — colour transform before format encoding
 *   4. toFormat — encode to the target format with quality setting
 *
 * `source` accepts either a `Buffer` (Sharp output in memory) or a filesystem
 * path string (temp file from multipart upload). Sharp handles both natively.
 *
 * This function is intentionally isolated from HTTP and DB concerns. It has no
 * imports from Fastify, Mongoose, or the storage layer — only Sharp and the
 * internal options schema. This makes it straightforward to unit-test with
 * synthetic inputs without spinning up any infrastructure.
 *
 * @param source  Image bytes (Buffer) or absolute path to the source file.
 * @param options Validated transform options (run through `validateTransformOptions` first).
 * @returns       Processed image buffer plus metadata.
 * @throws        If Sharp cannot decode the source or the transform fails.
 */
export async function processImage(
  source: Buffer | string,
  options: TransformOptions,
): Promise<ProcessingResult> {
  let pipeline = sharp(source);

  // 1. Rotate — apply before resize so the crop/fit operates on the rotated frame.
  //    Sharp's rotate() with an explicit angle does not use EXIF orientation.
  if (options.rotate !== 0) {
    pipeline = pipeline.rotate(options.rotate);
  }

  // 2. Resize — omit width/height if undefined to let Sharp preserve that dimension.
  if (options.width != null || options.height != null) {
    pipeline = pipeline.resize({
      width:  options.width,
      height: options.height,
      fit:    options.fit,
      withoutEnlargement: false, // allow upscaling — the caller controls max dimensions via validation
    });
  }

  // 3. Grayscale — colour transform applied after geometry ops.
  if (options.grayscale) {
    pipeline = pipeline.grayscale();
  }

  // 4. Encode to the target format with quality.
  //    `quality` applies to jpeg/webp/avif; PNG uses lossless compression
  //    and ignores this option (Sharp silently ignores it for PNG).
  pipeline = pipeline.toFormat(options.format, { quality: options.quality });

  const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });

  return {
    buffer:    data,
    mimeType:  FORMAT_MIME[options.format],
    width:     info.width,
    height:    info.height,
    sizeBytes: info.size,
  };
}
