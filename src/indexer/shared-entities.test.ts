import { beforeEach, describe, expect, it } from 'vitest';
import { ocflTestbed } from '../../test/app.ts';
import { type Crate, collection, crate, file, fileDescribedButNotHeld, object, type Part, person } from '../../test/crate-builder.ts';

const PERSON = 'https://orcid.org/0000-0002-1825-0097';
const FIRST = 'arcp://name,first';
const SECOND = 'arcp://name,second';
// Sorts before the others, so wins on crate id alone
const RESTRICTED = 'arcp://name,a-restricted';
const CLAIMS_COLLECTION = 'arcp://name,claims-collection';
const CLAIMS_OBJECT = 'arcp://name,claims-object';
const CLAIMS_FILE = 'arcp://name,claims-file';
const CALLS_AN_ORGANISATION = 'arcp://name,calls-an-organisation';
const DROPS = 'arcp://name,drops';

const organisation = (id: string, properties: Record<string, unknown> = {}): Part => ({
  entity: { '@id': id, '@type': 'Organization', conformsTo: { '@id': 'https://w3id.org/ldac/profile#Organization' }, ...properties },
});

const testbed = ocflTestbed(
  crate(collection(FIRST, { hasMember: [`${FIRST}/object`] }), [
    object(`${FIRST}/object`, { memberOf: FIRST, hasPart: ['data.txt'] }),
    file('data.txt', { content: 'Data', isPartOf: `${FIRST}/object` }),
    person(PERSON, { name: 'Ada (first)' }),
  ]),
  crate(collection(SECOND), [person(PERSON, { name: 'Ada (second)' })]),
  crate(collection(RESTRICTED), [person(PERSON, { name: 'Ada (restricted)' })], { metadataLicence: 'https://example.org/licenses/restricted' }),
  crate(collection(CLAIMS_COLLECTION), [collection(FIRST, { name: 'Claimed' })]),
  crate(collection(CLAIMS_OBJECT), [object(`${FIRST}/object`, { name: 'Claimed' })]),
  crate(collection(CLAIMS_FILE), [fileDescribedButNotHeld(`${FIRST}/data.txt`, { name: 'Claimed' })]),
  crate(collection(CALLS_AN_ORGANISATION), [organisation(PERSON, { name: 'Ada Inc' })]),
  crate(collection(DROPS), [person(PERSON, { name: 'Ada (drops)' })]),
);

const details = { message: 'Changed by a test', user: { name: 'Test' } };

const { run, state } = testbed;

const index = (...crateIds: string[]) => testbed.indexOnly(...crateIds);

const remove = (crateId: string) => run(() => testbed.started.indexQueue.delete(crateId));

/** Puts `built` in the repository as a new crate, or a new version of it */
const put = async (built: Crate) => {
  const { repository } = testbed.started;
  const write = (draft: { write: (path: string, content: string) => Promise<unknown> }) =>
    draft.write('ro-crate-metadata.json', JSON.stringify(built.metadata));
  if (await repository.has(built.id)) {
    await (await repository.open(built.id)).update(details, write);
  } else {
    await repository.create(built.id, details, write);
  }
};

/** The entity as the API serves it, or its status code */
const served = async (id: string) => {
  const { app, config } = testbed.started;
  const response = await app.inject({ method: 'GET', url: `${config.prefix}/entity/${encodeURIComponent(id)}` });
  return response.statusCode === 200 ? response.json() : response.statusCode;
};

/** The hits search finds for `id` */
const searched = async (id: string) => (await testbed.search({ query: '', limit: 100 })).entities.filter((hit: { id: string }) => hit.id === id);

/** The names in the search documents for `id` as search holds them, where its hits show the row's */
const documentNames = async (id: string) => {
  const { opensearch, config } = testbed.started;
  const { body } = await opensearch.search({ index: config.search.entityIndex, body: { query: { ids: { values: [id] } } } });
  return body.hits.hits.map(({ _source }) => (_source as { name: string }).name);
};

/** The person's name as its row and its document have it */
const personNames = async () => ({ row: (await served(PERSON)).name, documents: await documentNames(PERSON) });

const rows = () => testbed.started.prisma.entity.findMany({ orderBy: { id: 'asc' }, omit: { createdAt: true, updatedAt: true } });

beforeEach(async () => {
  await testbed.started.emptyEverything();
});

describe('a person two crates describe', () => {
  it('stays searchable and served when one of the crates is deleted', async () => {
    await index(FIRST, SECOND);

    await remove(SECOND);

    expect(await served(PERSON)).toMatchObject({ id: PERSON });
    expect(await searched(PERSON)).toHaveLength(1);

    await index(FIRST, SECOND);
    await remove(FIRST);

    expect(await served(PERSON)).toMatchObject({ id: PERSON });
    expect(await searched(PERSON)).toHaveLength(1);
  });

  it('is gone with the last crate that contains it', async () => {
    await index(FIRST, SECOND);

    await remove(FIRST);
    await remove(SECOND);

    expect(await served(PERSON)).toBe(404);
    expect(await searched(PERSON)).toEqual([]);
  });

  it('is wholly the copy of the crate with the lowest id, whichever is indexed first', async () => {
    await index(SECOND, FIRST);
    const secondFirst = await rows();

    expect(await personNames()).toEqual({ row: 'Ada (first)', documents: ['Ada (first)'] });

    await index(FIRST, SECOND);

    expect(await personNames()).toEqual({ row: 'Ada (first)', documents: ['Ada (first)'] });
    expect(await rows()).toEqual(secondFirst);
  });

  it('is the copy of a crate with an open metadata licence over a restricted one with a lower id', async () => {
    await index(RESTRICTED, SECOND);

    expect(await personNames()).toEqual({ row: 'Ada (second)', documents: ['Ada (second)'] });

    await index(SECOND, RESTRICTED);

    expect(await personNames()).toEqual({ row: 'Ada (second)', documents: ['Ada (second)'] });
  });

  it('is the restricted copy when no open one exists', async () => {
    await index(RESTRICTED);

    expect(await personNames()).toEqual({ row: 'Ada (restricted)', documents: ['Ada (restricted)'] });
  });

  it('becomes the next crate’s copy when the winning crate is deleted, without reading the repository', async () => {
    const gone = crate(collection('arcp://name,g-gone'), [person(PERSON, { name: 'Ada (gone)' })]);
    await put(gone);
    await index(FIRST, gone.id, SECOND);
    await testbed.started.repository.purge(gone.id);

    await remove(FIRST);

    expect(await personNames()).toEqual({ row: 'Ada (gone)', documents: ['Ada (gone)'] });
  });

  it('becomes the next crate’s copy when the winning crate is gone from the repository', async () => {
    const gone = crate(collection('arcp://name,a-gone'), [person(PERSON, { name: 'Ada (gone)' })]);
    await put(gone);
    await index(gone.id, SECOND);
    await testbed.started.repository.purge(gone.id);

    await run(() => testbed.started.indexQueue.index(gone.id));

    expect(await personNames()).toEqual({ row: 'Ada (second)', documents: ['Ada (second)'] });
  });

  it('becomes the next crate’s copy when the winning crate is reindexed without it', async () => {
    await put(crate(collection(DROPS), [person(PERSON, { name: 'Ada (drops)' })]));
    await index(DROPS, SECOND);

    await put(crate(collection(DROPS)));
    await run(() => testbed.started.indexQueue.index(DROPS));

    expect(await personNames()).toEqual({ row: 'Ada (second)', documents: ['Ada (second)'] });
    expect(await state(DROPS)).toMatchObject({ state: 'indexed', entities: 1 });
  });

  it('counts in each crate that contains it', async () => {
    await index(FIRST, SECOND);

    expect(await state(FIRST)).toMatchObject({ state: 'indexed', entities: 4, files: 1 });
    expect(await state(SECOND)).toMatchObject({ state: 'indexed', entities: 2, files: 0 });
  });

  it('is the copy of a crate indexed after everything was deleted', async () => {
    await index(FIRST, SECOND);

    await run(() => testbed.started.indexQueue.deleteEverything());
    await run(() => testbed.started.indexQueue.index(SECOND));

    expect(await personNames()).toEqual({ row: 'Ada (second)', documents: ['Ada (second)'] });
  });
});

describe('a crate describing what another crate holds', () => {
  it.each([
    ['a collection', CLAIMS_COLLECTION, FIRST],
    ['an object', CLAIMS_OBJECT, `${FIRST}/object`],
    ['a file', CLAIMS_FILE, `${FIRST}/data.txt`],
  ])('fails its job when it claims %s, naming both crates, and the holder keeps the row', async (_, claimant, claimed) => {
    await index(FIRST);
    const before = await rows();

    await run(() => testbed.started.indexQueue.index(claimant));

    expect(await state(claimant)).toMatchObject({
      state: 'failed',
      stage: 'database index',
      failedOn: claimed,
      error: expect.stringMatching(new RegExp(`${claimed}.*${FIRST}.*${claimant}`)),
    });
    expect((await rows()).filter(({ id }) => id !== claimant)).toEqual(before);
    expect(await state(FIRST)).toMatchObject({ state: 'indexed' });
  });

  it('fails its job when it describes a person as an organisation, naming both crates', async () => {
    await index(FIRST);

    await run(() => testbed.started.indexQueue.index(CALLS_AN_ORGANISATION));

    expect(await state(CALLS_AN_ORGANISATION)).toMatchObject({
      state: 'failed',
      stage: 'database index',
      failedOn: PERSON,
      error: expect.stringMatching(new RegExp(`${PERSON} is a .*Person in crate ${FIRST} but a .*Organization in crate ${CALLS_AN_ORGANISATION}`)),
    });
    expect(await personNames()).toEqual({ row: 'Ada (first)', documents: ['Ada (first)'] });
  });
});
