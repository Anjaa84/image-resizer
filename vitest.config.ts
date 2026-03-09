import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],

    // Set required env vars before any test module is imported.
    // The config module (src/config/index.ts) parses process.env at load time,
    // so these must be present before the first import resolves.
    env: {
      NODE_ENV:        'test',
      MONGO_URI:       'mongodb://localhost:27017/test-image-resizer',
      STORAGE_DRIVER:  'local',
      APP_BASE_URL:    'http://localhost:3000',
      UPLOAD_DIR:      './uploads',
      SYNC_MAX_SOURCE_BYTES:  '1048576',
      SYNC_MAX_OUTPUT_PIXELS: '2073600',
      SYNC_MAX_COMPLEXITY:    '1',
      QUEUE_MAX_ATTEMPTS:     '3',
      QUEUE_BACKOFF_DELAY_MS: '2000',
      STORAGE_DELETE_ON_ASSET_DELETE: 'false',
      MAX_UPLOAD_BYTES:  '52428800',
      MAX_IMAGE_WIDTH:   '10000',
      MAX_IMAGE_HEIGHT:  '10000',
      ALLOWED_MIME_TYPES: 'image/jpeg,image/png,image/webp,image/avif,image/tiff,image/gif,image/heic,image/heif',
    },

    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/server.ts', 'src/db/indexes.ts'],
    },
  },
});
