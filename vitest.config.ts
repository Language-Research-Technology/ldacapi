import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['test/global-setup.ts'],
    // Files share one database and search index
    fileParallelism: false,
  },
});
