/**
 * StorageDriver — the contract every storage backend must satisfy.
 *
 * The application never stores image binaries in MongoDB. MongoDB holds only
 * metadata and the storage `key` reference. The actual bytes live exclusively
 * in the storage layer, behind this interface.
 *
 * This separation means:
 *   - The API and worker are storage-agnostic; swapping local ↔ S3 requires
 *     only a config change, not a code change.
 *   - MongoDB documents stay small (metadata only), keeping queries fast.
 *   - File delivery scales independently of the database tier.
 *
 * Implementors:
 *   - LocalStorage  — filesystem-backed; used in development and CI
 *   - S3Storage     — AWS S3-backed; used in production (stub, ready to fill)
 */
export interface StorageDriver {
  /**
   * Persists a file to the storage backend under the given key.
   *
   * `source` is either:
   *   - a `Buffer`  — used when Sharp returns image data in memory (`.toBuffer()`)
   *   - a `string`  — a filesystem path to a temp file written by the multipart
   *                   upload handler; the storage driver streams it without
   *                   loading the entire file into memory
   *
   * The key is chosen by the caller (see `src/storage/key.ts`) before calling
   * save. The driver stores the bytes at exactly that key and nowhere else.
   *
   * Throws on failure. The caller is responsible for cleanup if save fails.
   */
  save(source: Buffer | string, key: string): Promise<void>;

  /**
   * Reads a stored file and returns its raw bytes as a Buffer.
   *
   * Used primarily by the worker to load an original file into Sharp for
   * processing. For S3, this downloads the object; for local storage it reads
   * the file from disk.
   *
   * Throws if the key does not exist.
   */
  read(key: string): Promise<Buffer>;

  /**
   * Removes the file at the given key from storage.
   *
   * Must be idempotent: if the key does not exist, the call succeeds silently
   * rather than throwing. This makes it safe to use in cleanup paths where the
   * existence of the file is not guaranteed (e.g., after a failed upload).
   */
  delete(key: string): Promise<void>;

  /**
   * Returns true if a file exists at the given key, false otherwise.
   *
   * Useful for pre-flight checks before attempting a read, and for verifying
   * that a write succeeded. Implemented as `HeadObject` on S3 and `fs.access`
   * on local storage — both are lightweight operations.
   */
  exists(key: string): Promise<boolean>;

  /**
   * Returns a fully-qualified URL that an HTTP client can use to download
   * the file directly — without going through the application server.
   *
   * For local storage: `{APP_BASE_URL}/files/{key}`, served by @fastify/static.
   * For S3: a CDN-fronted public URL or an AWS presigned URL.
   *
   * This URL is stored in `IAssetStorage.url` in MongoDB. It is the value
   * clients receive when they request a processed asset.
   *
   * Synchronous — URL construction does not require a network call for either
   * local storage or CDN-backed S3. If presigned URLs (time-limited) are
   * needed in the future, add a separate `getPresignedUrl(key, expiresIn)`
   * method rather than making this one async.
   */
  getUrl(key: string): string;
}

/**
 * Metadata returned after a successful save, used to populate the
 * `IAssetStorage` sub-document on an Asset record in MongoDB.
 */
export interface StorageSaveResult {
  /** The key under which the file was stored (driver-relative). */
  key: string;
  /** The publicly-accessible URL for the stored file. */
  url: string;
  /** The storage driver that wrote the file. */
  driver: 'local' | 's3';
  /** The S3 bucket name; undefined for local storage. */
  bucket?: string;
}
