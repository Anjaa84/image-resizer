import { config } from '../config';
import { LocalStorage } from './local.storage';
import { S3Storage } from './s3.storage';
import type { StorageDriver } from './storage.interface';

export function createStorageDriver(): StorageDriver {
  if (config.STORAGE_DRIVER === 's3') return new S3Storage();
  return new LocalStorage();
}

export const storage = createStorageDriver();
