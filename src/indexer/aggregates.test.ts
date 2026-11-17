import { beforeEach, describe, expect, it } from 'vitest';
import { ocflTestbed } from '../../test/app.ts';
import { collection, crate, fileDescribedButNotHeld, object, type Part } from '../../test/crate-builder.ts';

const SYDNEY_SPEAKS = 'arcp://name,sydney-speaks';
const SEVENTIES = 'arcp://name,interviews-1970s';
const EIGHTIES = 'arcp://name,interviews-1980s';

/** An object in `collectionId` with one recording, in each of `languages` */
const interview = (collectionId: string, n: number, languages: string[]): Part[] => [
  object(`${collectionId}/interview-${n}`, { memberOf: collectionId, hasPart: [`interview-${n}.wav`], inLanguage: languages }),
  fileDescribedButNotHeld(`interview-${n}.wav`, { isPartOf: `${collectionId}/interview-${n}`, encodingFormat: 'audio/wav' }),
];

const testbed = ocflTestbed(
  crate(collection(SYDNEY_SPEAKS, { name: 'Sydney Speaks', inLanguage: 'English' })),
  crate(collection(SEVENTIES, { memberOf: SYDNEY_SPEAKS }), [...interview(SEVENTIES, 1, ['English']), ...interview(SEVENTIES, 2, ['English'])]),
  crate(collection(EIGHTIES, { memberOf: SYDNEY_SPEAKS }), [
    ...interview(EIGHTIES, 1, ['English', 'Greek']),
    ...interview(EIGHTIES, 2, ['Greek']),
    ...interview(EIGHTIES, 3, ['English']),
  ]),
);

const entity = async (id: string) => {
  const { app, config } = testbed.started;
  const { counts, language, communicationMode, mediaType } = (
    await app.inject({ method: 'GET', url: `${config.prefix}/entity/${encodeURIComponent(id)}` })
  ).json();
  return { counts, language, communicationMode, mediaType };
};

const run = async (ask: () => Promise<unknown>) => {
  await ask();
  await testbed.started.workTheQueue();
};

beforeEach(async () => {
  await testbed.indexOnly(SYDNEY_SPEAKS, SEVENTIES, EIGHTIES);
});

describe('aggregates of a collection split across crates', () => {
  it('read as the sum of what each crate adds, with their languages combined', async () => {
    expect(await entity(SYDNEY_SPEAKS)).toEqual({
      counts: { collections: 2, objects: 5, subCollections: 2, files: 5 },
      language: ['English', 'Greek'],
      communicationMode: [],
      mediaType: ['audio/wav'],
    });
  });

  it('give each child crate’s collection only its own', async () => {
    expect(await entity(EIGHTIES)).toEqual({
      counts: { collections: 0, objects: 3, subCollections: 0, files: 3 },
      language: ['English', 'Greek'],
      communicationMode: [],
      mediaType: ['audio/wav'],
    });
  });

  it('lose only a deleted child crate’s share', async () => {
    await run(() => testbed.started.indexQueue.delete(EIGHTIES));

    expect(await entity(SYDNEY_SPEAKS)).toEqual({
      counts: { collections: 1, objects: 2, subCollections: 1, files: 2 },
      language: ['English'],
      communicationMode: [],
      mediaType: ['audio/wav'],
    });
  });

  it('are the same after a child crate is reindexed', async () => {
    const before = await entity(SYDNEY_SPEAKS);

    await run(() => testbed.started.indexQueue.reindex(SEVENTIES));

    expect(await entity(SYDNEY_SPEAKS)).toEqual(before);
  });

  it('are gone once everything is deleted', async () => {
    await run(() => testbed.started.indexQueue.deleteEverything());

    expect(await testbed.started.prisma.aggregate.count()).toBe(0);
  });

  it('are gone for a crate gone from the repository', async () => {
    await testbed.started.repository.remove(EIGHTIES);

    await run(() => testbed.started.indexQueue.index(EIGHTIES));

    expect(await testbed.started.prisma.aggregate.count({ where: { crateId: EIGHTIES } })).toBe(0);
    expect((await entity(SYDNEY_SPEAKS)).counts).toEqual({ collections: 1, objects: 2, subCollections: 1, files: 2 });
  });
});
