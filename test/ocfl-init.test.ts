import { execFileSync } from 'node:child_process';
import { access, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('ocfl:init', () => {
  let storage: string;
  let root: string;
  const init = () => execFileSync('node', ['scripts/ocfl-init.ts'], { env: { ...process.env, OCFL_ROOT: root, LOG_LEVEL: 'silent' }, stdio: 'ignore' });

  beforeEach(async () => {
    storage = await mkdtemp(join(tmpdir(), 'ldacapi-'));
    root = join(storage, 'ocfl');
  });

  afterEach(async () => {
    await rm(storage, { recursive: true, force: true });
  });

  it('creates an empty OCFL repository', async () => {
    init();

    await expect(access(join(root, '0=ocfl_1.1'))).resolves.toBeUndefined();
  });

  it('leaves an existing repository as it is', async () => {
    init();
    const before = await readdir(root);

    init();

    expect(await readdir(root)).toEqual(before);
  });
});
