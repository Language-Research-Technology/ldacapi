import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['test/global-setup.ts'],
    exclude: [...configDefaults.exclude, '.claude/**'],
    // Files share one database and search index
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      // Entry points (scripts/, src/index.ts, src/worker.ts) run as their own process, unseen by coverage; they only parse arguments and call src/
      include: ['src/**/*.ts'],
      exclude: ['src/generated/**', 'src/**/*.test.ts', 'src/index.ts', 'src/worker.ts'],
      thresholds: {
        // Raised by vitest whenever a run beats them; commit the change
        autoUpdate: true,
        lines: 98.6,
        branches: 95.72,
        functions: 98.84,
        statements: 98.58,
        'src/indexer/**': { lines: 100, branches: 100, functions: 100, statements: 100 },
        'src/index-queue/**': { lines: 100, branches: 100, functions: 100, statements: 100 },
      },
    },
  },
});
