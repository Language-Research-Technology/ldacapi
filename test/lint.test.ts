import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** Files that import the indexer, by where they sit in the project */
const importers = {
  'src/admin/plugin.ts': '../indexer/indexer.ts',
  'src/index-queue/index-queue.ts': '../indexer/indexer.ts',
  'src/worker.ts': './indexer/indexer.ts',
  'src/indexer/crate.ts': './indexer.ts',
  'scripts/index.ts': '../src/indexer/indexer.ts',
  'test/app.ts': '../src/indexer/indexer.ts',
};

describe('the rule on importing the indexer', () => {
  let project: string;
  let output: string;

  beforeAll(async () => {
    project = await mkdtemp(join(tmpdir(), 'ldacapi-lint-'));
    await copyFile('biome.jsonc', join(project, 'biome.jsonc'));
    for (const [path, specifier] of Object.entries(importers)) {
      await mkdir(dirname(join(project, path)), { recursive: true });
      await writeFile(join(project, path), `import { workTheQueue } from '${specifier}';\n\nexport const run = workTheQueue;\n`);
    }
    const lint = spawnSync(resolve('node_modules/.bin/biome'), ['lint', '--vcs-enabled=false', '--max-diagnostics=50', '.'], {
      cwd: project,
      encoding: 'utf8',
    });
    output = lint.stdout + lint.stderr;
  });

  afterAll(async () => {
    await rm(project, { recursive: true, force: true });
  });

  it.each(['src/admin/plugin.ts', 'src/index-queue/index-queue.ts'])('fails an import from %s', (path) => {
    expect(output).toContain(`${path}:1:30 lint/style/noRestrictedImports`);
  });

  it.each(['src/worker.ts', 'src/indexer/crate.ts', 'scripts/index.ts', 'test/app.ts'])('allows an import from %s', (path) => {
    expect(output).not.toContain(`${path}:`);
  });
});
