import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config';
import type { StorageDriver } from './storage.interface';

/**
 * LocalStorage — filesystem-backed storage driver for development and CI.
 *
 * Files are stored under `UPLOAD_DIR` (default: `./uploads`), organised by
 * the key hierarchy:
 *
 *   uploads/
 *     originals/
 *       {sha256hash}.jpg          ← content-addressed originals
 *     derived/
 *       {sourceAssetId}/
 *         {transformSignature}.webp  ← one dir per original
 *
 * URLs are constructed as `{APP_BASE_URL}/files/{key}`. The Fastify server
 * must register @fastify/static to serve UPLOAD_DIR at the `/files` prefix:
 *
 *   app.register(fastifyStatic, {
 *     root: path.resolve(config.UPLOAD_DIR),
 *     prefix: '/files/',
 *   });
 *
 * NOT suitable for multi-replica deployments — each API/worker instance
 * would need access to the same shared volume. Use S3Storage in production.
 */
export class LocalStorage implements StorageDriver {
  private readonly baseDir: string;
  private readonly baseUrl: string;

  constructor() {
    // Resolve to an absolute path so all operations are unambiguous regardless
    // of the process working directory.
    this.baseDir = path.resolve(config.UPLOAD_DIR);
    // Strip trailing slash for clean URL concatenation.
    this.baseUrl = config.APP_BASE_URL.replace(/\/$/, '');
  }

  // ─── Private Helpers ───────────────────────────────────────────────────────

  /**
   * Resolves a storage key to an absolute filesystem path.
   * Guards against path-traversal attacks: the resolved path must remain
   * inside baseDir. A crafted key containing '../' sequences would produce a
   * path outside baseDir, which this check rejects.
   */
  private resolvePath(key: string): string {
    const resolved = path.resolve(this.baseDir, key);
    if (!resolved.startsWith(this.baseDir + path.sep) && resolved !== this.baseDir) {
      throw new Error(
        `Storage key escapes base directory: "${key}" resolved to "${resolved}"`,
      );
    }
    return resolved;
  }

  /**
   * Ensures the directory containing `filePath` exists, creating it and all
   * intermediate directories if needed. Called before every write.
   */
  private async ensureDir(filePath: string): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
  }

  // ─── StorageDriver Implementation ─────────────────────────────────────────

  /**
   * Saves a file to local storage.
   *
   * Accepts either a Buffer (Sharp output) or a string filepath (temp file
   * from the multipart upload handler). Using `copyFile` for paths avoids
   * loading the full file into Node.js memory — the OS handles the copy.
   */
  async save(source: Buffer | string, key: string): Promise<void> {
    const dest = this.resolvePath(key);
    await this.ensureDir(dest);

    if (Buffer.isBuffer(source)) {
      await fs.writeFile(dest, source);
    } else {
      // source is a filesystem path — stream via OS copy, not through Node.
      await fs.copyFile(source, dest);
    }
  }

  /**
   * Reads a stored file and returns its raw bytes.
   * Throws ENOENT if the key does not exist.
   */
  async read(key: string): Promise<Buffer> {
    const filePath = this.resolvePath(key);
    return fs.readFile(filePath);
  }

  /**
   * Deletes the file at the given key.
   * Idempotent: silently succeeds if the file does not exist (ENOENT).
   * Re-throws any other filesystem errors (permission denied, etc.).
   */
  async delete(key: string): Promise<void> {
    const filePath = this.resolvePath(key);
    try {
      await fs.unlink(filePath);
    } catch (err) {
      if (isErrnoException(err) && err.code === 'ENOENT') return;
      throw err;
    }
  }

  /**
   * Returns true if a file exists and is readable at the given key.
   * Uses fs.access (cheaper than stat — does not return file metadata).
   */
  async exists(key: string): Promise<boolean> {
    const filePath = this.resolvePath(key);
    try {
      await fs.access(filePath, fs.constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Verifies that UPLOAD_DIR exists and is readable + writable.
   * Throws an ENOENT/EACCES error if the directory is missing or inaccessible.
   */
  async ping(): Promise<void> {
    await fs.access(this.baseDir, fs.constants.R_OK | fs.constants.W_OK);
  }

  /**
   * Returns the publicly-accessible URL for the file.
   * Format: {APP_BASE_URL}/files/{key}
   *
   * This URL is served by @fastify/static at the `/files` prefix. The key
   * may contain slashes (e.g. `derived/abc/def.webp`), which become path
   * segments in the URL — the static server traverses them correctly.
   */
  getUrl(key: string): string {
    return `${this.baseUrl}/files/${key}`;
  }
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return typeof err === 'object' && err !== null && 'code' in err;
}
