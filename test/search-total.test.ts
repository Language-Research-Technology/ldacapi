import { beforeAll, describe, expect, it } from 'vitest';
import { ocflTestbed } from './app.ts';
import { collection, crate, object } from './crate-builder.ts';

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
  await testbed.indexOnly(ROOT);
});

describe('an entity whose row fails to be written', () => {
  it('fails the job, recording the entity, with no indexed version', async () => {
    expect(await testbed.started.indexQueue.crate(ROOT)).toMatchObject({ state: 'failed', stage: 'database index', failedOn: UNWRITTEN, attempts: 1 });
  });

  it('leaves none of the crate counted by search', async () => {
    const { total, entities } = await search({ query: '', limit: 100 });

    expect(entities).toEqual([]);
    expect(total).toBe(0);
  });

  it('fails the job again once the crate is reindexed', async () => {
    await testbed.started.indexQueue.reindex(ROOT);
    await testbed.started.workTheQueue();

    expect(await testbed.started.indexQueue.crate(ROOT)).toMatchObject({ state: 'failed', failedOn: UNWRITTEN });
    expect((await search({ query: '', limit: 100 })).total).toBe(0);
  });
});
