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
    },

    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/server.ts', 'src/db/indexes.ts'],
    },
  },
});
