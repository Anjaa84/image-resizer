export interface StorageDriver {
  save(sourcePath: string, destinationKey: string): Promise<string>;
  getUrl(key: string): string;
  delete(key: string): Promise<void>;
}
