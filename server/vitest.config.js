import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: './test/globalSetup.js',
    setupFiles: ['./test/setup.js'],
    // Files share one in-memory replica set but each uses its own database.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
