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
      thresholds: { 100: true },
    },
  },
});
