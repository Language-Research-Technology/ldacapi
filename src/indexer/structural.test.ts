import fs from 'node:fs';
import { ROCrate } from 'ro-crate';
import { describe, expect, it } from 'vitest';
import { entityAsCrate } from './structural.ts';

describe('entityAsCrate', () => {
  it('preserves the original RO-Crate context when serializing an entity', async () => {
    const raw = JSON.parse(fs.readFileSync('./test-data/distributed_root/ro-crate-metadata.json', 'utf8'));

    const crate = await ROCrate.create(raw);
    const result = entityAsCrate(crate, crate.root, '');
    expect(result['@context']).toEqual(crate['@context']);
  });
});
