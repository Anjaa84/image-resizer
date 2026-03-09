/**
 * S3Storage — AWS S3-compatible storage driver for production.
 *
 * ── Status ────────────────────────────────────────────────────────────────────
 * Structured stub. Method signatures are final; bodies are not yet implemented.
 * The interface contract is fully defined so the worker and service layers can
 * be written against it without waiting for S3 implementation.
 *
 * ── Implementation Guide ──────────────────────────────────────────────────────
 * Install the AWS SDK v3 client before implementing:
 *
 *   npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner
 *
 * Each method maps to a single S3 operation:
 *
 *   save   → PutObjectCommand   (upload Buffer or stream)
 *   read   → GetObjectCommand   (download to Buffer)
 *   delete → DeleteObjectCommand (idempotent)
 *   exists → HeadObjectCommand  (cheap metadata-only check)
 *   getUrl → CDN URL or GetSignedUrl (see note below)
 *
 * ── URL Strategy ──────────────────────────────────────────────────────────────
 * `getUrl` is synchronous per the StorageDriver interface, which rules out
 * AWS presigned URLs (they require an async SDK call). Two options:
 *
 *   Option A (recommended): Put CloudFront or another CDN in front of S3.
 *     getUrl returns `https://{CDN_DOMAIN}/{key}`. Fast, cacheable, no expiry.
 *
 *   Option B: Use public S3 bucket (less secure, simpler).
 *     getUrl returns `https://{bucket}.s3.{region}.amazonaws.com/{key}`.
 *
 *   Option C: If presigned URLs are required, add a separate async method
 *     `getPresignedUrl(key, expiresInSeconds): Promise<string>` to the
 *     StorageDriver interface and implement it here.
 *
 * ── Configuration ─────────────────────────────────────────────────────────────
 * The following env vars are already defined in src/config/index.ts:
 *   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, S3_BUCKET
 *
 * Add CDN_BASE_URL when implementing Option A:
 *   CDN_BASE_URL=https://assets.yourdomain.com
 */

import type { StorageDriver } from './storage.interface';

export class S3Storage implements StorageDriver {
  // ── S3Client would be initialised here ──────────────────────────────────
  //
  // private readonly client: S3Client;
  // private readonly bucket: string;
  // private readonly cdnBaseUrl: string;
  //
  // constructor() {
  //   this.client = new S3Client({
  //     region: config.AWS_REGION,
  //     credentials: {
  //       accessKeyId:     config.AWS_ACCESS_KEY_ID!,
  //       secretAccessKey: config.AWS_SECRET_ACCESS_KEY!,
  //     },
  //   });
  //   this.bucket     = config.S3_BUCKET!;
  //   this.cdnBaseUrl = config.CDN_BASE_URL!.replace(/\/$/, '');
  // }

  /**
   * Uploads a file to S3.
   *
   * Implementation:
   *   const body = Buffer.isBuffer(source) ? source : createReadStream(source);
   *   await this.client.send(new PutObjectCommand({
   *     Bucket: this.bucket,
   *     Key:    key,
   *     Body:   body,
   *     ContentType: mime.getType(key) ?? 'application/octet-stream',
   *   }));
   */
  async save(_source: Buffer | string, _key: string): Promise<void> {
    throw new Error('S3Storage.save: not yet implemented. See file header for guide.');
  }

  /**
   * Downloads an S3 object and returns its content as a Buffer.
   *
   * Implementation:
   *   const response = await this.client.send(new GetObjectCommand({
   *     Bucket: this.bucket,
   *     Key:    key,
   *   }));
   *   return Buffer.from(await response.Body!.transformToByteArray());
   */
  async read(_key: string): Promise<Buffer> {
    throw new Error('S3Storage.read: not yet implemented. See file header for guide.');
  }

  /**
   * Deletes an S3 object. DeleteObjectCommand is idempotent by default —
   * S3 returns 204 even if the key does not exist, matching our interface
   * contract that delete must not throw on missing keys.
   *
   * Implementation:
   *   await this.client.send(new DeleteObjectCommand({
   *     Bucket: this.bucket,
   *     Key:    key,
   *   }));
   */
  async delete(_key: string): Promise<void> {
    throw new Error('S3Storage.delete: not yet implemented. See file header for guide.');
  }

  /**
   * Checks for object existence using HeadObject (metadata only, no download).
   *
   * Implementation:
   *   try {
   *     await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
   *     return true;
   *   } catch (err) {
   *     if (err instanceof NotFound || (err as any).$metadata?.httpStatusCode === 404) {
   *       return false;
   *     }
   *     throw err;
   *   }
   */
  async exists(_key: string): Promise<boolean> {
    throw new Error('S3Storage.exists: not yet implemented. See file header for guide.');
  }

  /**
   * Returns the CDN or public S3 URL for a stored object.
   * See URL Strategy in the file header for options.
   *
   * Implementation (CDN option):
   *   return `${this.cdnBaseUrl}/${key}`;
   */
  getUrl(_key: string): string {
    throw new Error('S3Storage.getUrl: not yet implemented. See file header for guide.');
  }
}
