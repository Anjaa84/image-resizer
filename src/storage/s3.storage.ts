/**
 * S3 storage driver — stub for future implementation.
 * Install @aws-sdk/client-s3 and implement when STORAGE_DRIVER=s3.
 */
import type { StorageDriver } from './storage.interface';

export class S3Storage implements StorageDriver {
  async save(_sourcePath: string, _destinationKey: string): Promise<string> {
    throw new Error('S3Storage not yet implemented');
  }

  getUrl(_key: string): string {
    throw new Error('S3Storage not yet implemented');
  }

  async delete(_key: string): Promise<void> {
    throw new Error('S3Storage not yet implemented');
  }
}
