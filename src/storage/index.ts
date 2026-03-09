import { config } from '../config';
import { LocalStorage } from './local.storage';
import { S3Storage } from './s3.storage';
import type { StorageDriver, StorageSaveResult } from './storage.interface';

export type { StorageDriver, StorageSaveResult };
export { originalKey, derivedKey, sourceIdFromDerivedKey } from './key';

/**
 * Instantiates the configured storage driver.
 *
 * The driver is selected at startup from the STORAGE_DRIVER env var.
 * Changing storage backends requires only an env change — no code changes.
 *
 * @throws if STORAGE_DRIVER is 's3' and required AWS config is missing.
 */
function createStorageDriver(): StorageDriver {
  switch (config.STORAGE_DRIVER) {
    case 's3':
      // Validate required S3 config at startup rather than at first use.
      // Failing fast here is much friendlier than a cryptic error mid-request.
      if (!config.AWS_ACCESS_KEY_ID || !config.AWS_SECRET_ACCESS_KEY || !config.S3_BUCKET) {
        throw new Error(
          'STORAGE_DRIVER=s3 requires AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and S3_BUCKET to be set.',
        );
      }
      return new S3Storage();

    case 'local':
    default:
      return new LocalStorage();
  }
}

/**
 * Application-wide storage driver singleton.
 *
 * Import this wherever file I/O is needed — the API (to save uploaded
 * originals) and the worker (to read originals and write derived outputs).
 *
 * Do not call createStorageDriver() elsewhere; use this singleton to ensure
 * all parts of the application share the same driver instance and config.
 */
export const storage = createStorageDriver();
