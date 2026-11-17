import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['test/global-setup.ts'],
    // Files share one database and search index
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      // Entry points (scripts/, src/index.ts) run as their own process, unseen by coverage; they only parse arguments and call src/
      include: ['src/**/*.ts'],
      exclude: ['src/generated/**', 'src/**/*.test.ts', 'src/index.ts'],
      thresholds: {
        // Raised by vitest whenever a run beats them; commit the change
        autoUpdate: true,
        lines: 93.69,
        branches: 87.8,
        functions: 95.76,
        statements: 94,
      },
    },
  },
});
