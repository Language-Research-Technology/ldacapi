import type { OcflFile, OcflObject, StorageRoot } from '@ocfl/ocfl-fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ocflTestbed } from '../../test/app.ts';
import { collection, crate, file, object } from '../../test/crate-builder.ts';
import { countStates } from '../index-queue/index-queue.ts';

vi.mock('../logger.ts', async () => (await import('../../test/logs.ts')).capturingLogger([], 'warn'));

const TOP = 'arcp://name,reads-top';
const PARENT = 'arcp://name,reads-parent';
const CHILDREN = Array.from({ length: 5 }, (_, n) => `arcp://name,reads-child-${n}`);
const METADATA = 'ro-crate-metadata.json';

const testbed = ocflTestbed(
  crate(collection(TOP)),
  crate(collection(PARENT, { memberOf: TOP })),
  ...CHILDREN.map((id) =>
    crate(collection(id, { memberOf: PARENT, hasMember: [`${id}/object`] }), [
      object(`${id}/object`, { memberOf: id, hasPart: ['text.txt'] }),
      file('text.txt', { content: 'Some text', encodingFormat: 'text/plain', isPartOf: `${id}/object` }),
    ]),
  ),
);

const tally = () => {
  const counts = new Map<string, number>();
  return {
    add: (id: string) => counts.set(id, (counts.get(id) ?? 0) + 1),
    of: (id: string) => counts.get(id) ?? 0,
    clear: () => counts.clear(),
  };
};

const opens = tally();
const metadataReads = tally();

/** `object`, counting each read of its crate's metadata */
function countingMetadataReads(object: OcflObject): OcflObject {
  const metadata = object.head.files.get(METADATA);
  if (!metadata) {
    return object;
  }
  const text: OcflFile['text'] = (...args) => {
    metadataReads.add(object.id);
    return metadata.text(...args);
  };
  const counted = new Proxy(metadata, {
    get: (file, key) => {
      const value = key === 'text' ? text : Reflect.get(file, key);
      return typeof value === 'function' ? value.bind(file) : value;
    },
  });
  const files = new Map(object.head.files).set(METADATA, counted);
  return Object.create(object, { head: { value: Object.create(object.head, { files: { value: files } }) } });
}

/** The repository, counting each object it opens and each crate's metadata read */
const counting = (repository: StorageRoot): StorageRoot => ({
  ...repository,
  async open(id) {
    opens.add(id);
    return countingMetadataReads(await repository.open(id));
  },
});

const deps = () => ({ ...testbed.started.indexer, repository: counting(testbed.started.repository) });

const workTheQueueOnce = async () => {
  // Imported once the testbed has read its configuration
  const { workTheQueue } = await import('./indexer.ts');
  await workTheQueue(deps(), { until: 'empty' });
};

beforeEach(async () => {
  await testbed.started.emptyEverything();
  opens.clear();
  metadataReads.clear();
});

describe('a job', () => {
  it("opens its crate's OCFL object once", async () => {
    await testbed.started.indexQueue.index(CHILDREN[0] as string);

    await workTheQueueOnce();

    expect(opens.of(CHILDREN[0] as string)).toBe(1);
    expect(metadataReads.of(CHILDREN[0] as string)).toBe(1);
  });
});

describe('a worker indexing many child crates', () => {
  it("reads each parent crate's metadata once", async () => {
    for (const id of CHILDREN) {
      await testbed.started.indexQueue.index(id);
    }

    await workTheQueueOnce();

    expect(countStates(await testbed.started.indexQueue.crates())).toMatchObject({ indexed: CHILDREN.length });
    expect(metadataReads.of(PARENT)).toBe(1);
    expect(metadataReads.of(TOP)).toBe(1);
  });

  it('reads a parent crate again once it has changed', async () => {
    const { indexQueue, prisma, repository } = testbed.started;
    const [first, second] = CHILDREN as [string, string];
    const { workTheQueue } = await import('./indexer.ts');
    const stop = new AbortController();
    const working = workTheQueue(deps(), { until: 'aborted', signal: stop.signal });
    const rootCollectionOf = async (id: string) => (await prisma.entity.findUniqueOrThrow({ where: { id }, select: { rootCollection: true } })).rootCollection;
    try {
      await indexQueue.index(first);
      await vi.waitFor(async () => expect(await indexQueue.crate(first)).toMatchObject({ state: 'indexed' }), { timeout: 10_000 });
      expect(await rootCollectionOf(first)).toBe(TOP);

      const parent = await repository.open(PARENT);
      await parent.update({ message: 'No longer a member of the top collection', user: { name: 'Test' } }, (draft) =>
        draft.write(METADATA, JSON.stringify(crate(collection(PARENT)).metadata)),
      );
      await indexQueue.index(second);
      await vi.waitFor(async () => expect(await indexQueue.crate(second)).toMatchObject({ state: 'indexed' }), { timeout: 10_000 });
    } finally {
      stop.abort();
      await working;
      const original = await repository.open(PARENT);
      await original.update({ message: 'Back under the top collection', user: { name: 'Test' } }, (draft) =>
        draft.write(METADATA, JSON.stringify(crate(collection(PARENT, { memberOf: TOP })).metadata)),
      );
    }

    expect(await rootCollectionOf(second)).toBe(PARENT);
    expect(metadataReads.of(PARENT)).toBe(2);
  });
});
