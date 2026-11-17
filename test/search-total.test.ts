import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ocflTestbed } from './app.ts';
import { collection, crate, object } from './crate-builder.ts';

const logs = vi.hoisted(() => [] as Record<string, unknown>[]);

vi.mock('../src/logger.ts', async () => (await import('./logs.ts')).capturingLogger(logs, 'info'));

const ROOT = 'arcp://name,unwritable';
const WRITTEN = `${ROOT}/written`;
// Postgres can't store a NUL character, so this entity's row fails to be written
const UNWRITTEN = `${ROOT}/unwritten`;
const testbed = ocflTestbed(
  crate(collection(ROOT, { name: 'Unwritable' }), [
    object(WRITTEN, { memberOf: ROOT, name: 'Written' }),
    object(UNWRITTEN, { memberOf: ROOT, name: 'Unwritten\u0000' }),
  ]),
);
const { search } = testbed;

beforeAll(async () => {
  await testbed.started.repository.deleteIndex();
  await testbed.started.repository.createIndex(ROOT);
});

describe('an entity whose row fails to be written', () => {
  it('is not counted by search', async () => {
    const { total, entities, facets } = await search({ query: '', limit: 100 });

    expect(entities.map(({ id }: { id: string }) => id).sort()).toEqual([ROOT, WRITTEN]);
    expect(total).toBe(2);
    expect(facets.recordType.reduce((sum: number, { count }: { count: number }) => sum + count, 0)).toBe(2);
  });

  it('is not counted when the search index is rebuilt alone', async () => {
    await testbed.started.repository.createIndex(ROOT, 'search', true);

    const { total, entities } = await search({ query: '', limit: 100 });

    expect(entities.map(({ id }: { id: string }) => id).sort()).toEqual([ROOT, WRITTEN]);
    expect(total).toBe(2);
  });

  it('logs the skip with the crate and entity ids', () => {
    expect(logs).toContainEqual(expect.objectContaining({ level: 40, crateId: ROOT, entityId: UNWRITTEN, msg: 'Skipped: no database row' }));
  });

  it('logs the documents it indexed', () => {
    expect(logs).toContainEqual(expect.objectContaining({ module: 'indexer/search', crateId: ROOT, documents: 2, msg: 'Indexed crate' }));
  });
});

describe('a crate with no database rows', () => {
  it('logs the skip once for the crate', async () => {
    await testbed.started.repository.deleteIndex(ROOT);
    logs.length = 0;

    await testbed.started.repository.createIndex(ROOT, 'search');

    const skips = logs.filter(({ msg }) => typeof msg === 'string' && msg.startsWith('Skipped'));
    expect(skips).toEqual([expect.objectContaining({ level: 40, crateId: ROOT, skipped: 3, msg: 'Skipped crate: no database rows' })]);
  });
});
