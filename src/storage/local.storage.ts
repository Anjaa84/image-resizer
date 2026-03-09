import fs from 'fs/promises';
import path from 'path';
import { config } from '../config';
import type { StorageDriver } from './storage.interface';

export class LocalStorage implements StorageDriver {
  private readonly baseDir = config.UPLOAD_DIR;

  async save(sourcePath: string, destinationKey: string): Promise<string> {
    const dest = path.join(this.baseDir, destinationKey);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(sourcePath, dest);
    return dest;
  }

  getUrl(key: string): string {
    return `/files/${key}`;
  }

  async delete(key: string): Promise<void> {
    await fs.unlink(path.join(this.baseDir, key));
  }
}
