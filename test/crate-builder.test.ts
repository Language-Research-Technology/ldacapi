import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStorageRoot } from '@ocfl/ocfl-fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { importCrates } from '../src/crates-import.ts';
import { openOrCreateRepository } from '../src/repository/repository.ts';
import { type Crate, collection, crate, file, fileDescribedButNotHeld, licence, object, person, writeCrates } from './crate-builder.ts';

const ROOT = 'arcp://name,builder';

let storage: string;

beforeEach(async () => {
  storage = await mkdtemp(join(tmpdir(), 'ldacapi-'));
});

afterEach(async () => {
  await rm(storage, { recursive: true, force: true });
});

/** The head version of each crate's OCFL object after importing `crates` into a new repository */
const imported = async (...crates: Crate[]) => {
  const source = join(storage, 'crates');
  const root = join(storage, 'ocfl');
  await writeCrates(source, crates);
  expect(await importCrates(await openOrCreateRepository(root), source, { mode: 'sync' })).toBe(true);
  const repository = await openStorageRoot(root);
  return async (id: string) => (await repository.open(id)).head;
};

const metadataOf = async (head: Awaited<ReturnType<Awaited<ReturnType<typeof imported>>>>) =>
  JSON.parse((await head.files.get('ro-crate-metadata.json')?.text()) ?? '{}');

const entityIn = (metadata: { '@graph': Record<string, unknown>[] }, id: string) => metadata['@graph'].find((entity) => entity['@id'] === id);

describe('a crate stated inline', () => {
  it('is written into the repository with the files it holds', async () => {
    const head = await (await imported(crate(collection(ROOT, { name: 'Builder' }), [file('data.txt', { content: 'hello' })])))(ROOT);

    expect(await head.files.get('data.txt')?.text()).toBe('hello');
    const metadata = await metadataOf(head);
    expect(entityIn(metadata, 'ro-crate-metadata.json')).toMatchObject({ about: { '@id': ROOT } });
    expect(entityIn(metadata, ROOT)).toMatchObject({ '@type': ['Dataset', 'RepositoryCollection'], name: 'Builder' });
    expect(entityIn(metadata, 'data.txt')).toMatchObject({ '@type': 'File' });
  });

  it('describes a file it does not hold', async () => {
    const head = await (await imported(crate(collection(ROOT), [fileDescribedButNotHeld('elsewhere.wav', { contentSize: '1024' })])))(ROOT);

    expect(head.files.has('elsewhere.wav')).toBe(false);
    expect(entityIn(await metadataOf(head), 'elsewhere.wav')).toMatchObject({ '@type': 'File', contentSize: '1024' });
  });

  it('links collections, objects and files in the pcdm: spellings, each conforming to its LDaC profile', async () => {
    const SUB = `${ROOT}/sub`;
    const OBJECT = `${ROOT}/object`;
    const head = await (
      await imported(
        crate(collection(ROOT, { hasMember: [SUB] }), [
          collection(SUB),
          object(OBJECT, { memberOf: SUB, hasPart: ['a.txt'], 'ldac:communicationMode': { '@id': 'https://w3id.org/ldac/terms#SpokenLanguage' } }),
          file('a.txt', { content: 'a', isPartOf: OBJECT }),
        ]),
      )
    )(ROOT);

    const metadata = await metadataOf(head);
    expect(entityIn(metadata, ROOT)).toMatchObject({
      conformsTo: { '@id': 'https://w3id.org/ldac/profile#Collection' },
      'pcdm:hasMember': [{ '@id': SUB }],
    });
    expect(entityIn(metadata, OBJECT)).toMatchObject({
      '@type': ['Dataset', 'RepositoryObject'],
      conformsTo: { '@id': 'https://w3id.org/ldac/profile#Object' },
      'pcdm:memberOf': { '@id': SUB },
      hasPart: [{ '@id': 'a.txt' }],
      'ldac:communicationMode': { '@id': 'https://w3id.org/ldac/terms#SpokenLanguage' },
    });
    expect(entityIn(metadata, 'a.txt')).toMatchObject({ isPartOf: { '@id': OBJECT } });
    expect(JSON.stringify(metadata)).not.toMatch(/"(memberOf|hasMember)"/);
  });

  it('puts its root and metadata under CC BY 4.0 unless told otherwise', async () => {
    const metadata = await metadataOf(await (await imported(crate(collection(ROOT))))(ROOT));

    expect(entityIn(metadata, 'ro-crate-metadata.json')).toMatchObject({ license: { '@id': 'https://creativecommons.org/licenses/by/4.0/' } });
    expect(entityIn(metadata, ROOT)).toMatchObject({ license: { '@id': 'https://creativecommons.org/licenses/by/4.0/' } });
    expect(entityIn(metadata, 'https://creativecommons.org/licenses/by/4.0/')).toMatchObject({ '@type': 'CreativeWork' });
  });

  it('states licences and people, describing each licence once', async () => {
    const OBJECT = `${ROOT}/object`;
    const PERSON = 'https://orcid.org/0000-0000-0000-0001';
    const RESTRICTED = 'https://example.org/licenses/restricted';
    const head = await (
      await imported(
        crate(
          collection(ROOT, { licence: RESTRICTED }),
          [
            object(OBJECT, { memberOf: ROOT, licence: RESTRICTED, author: { '@id': PERSON } }),
            licence(RESTRICTED, { name: 'Restricted' }),
            person(PERSON, { name: 'Jane Smith' }),
          ],
          { metadataLicence: 'https://example.org/licenses/metadata' },
        ),
      )
    )(ROOT);

    const metadata = await metadataOf(head);
    expect(entityIn(metadata, 'ro-crate-metadata.json')).toMatchObject({ license: { '@id': 'https://example.org/licenses/metadata' } });
    expect(entityIn(metadata, ROOT)).toMatchObject({ license: { '@id': RESTRICTED } });
    expect(entityIn(metadata, OBJECT)).toMatchObject({ license: { '@id': RESTRICTED } });
    expect(metadata['@graph'].filter((entity: { '@id': string }) => entity['@id'] === RESTRICTED)).toEqual([
      { '@id': RESTRICTED, '@type': 'CreativeWork', name: 'Restricted' },
    ]);
    expect(entityIn(metadata, 'https://example.org/licenses/metadata')).toMatchObject({ '@type': 'CreativeWork' });
    expect(entityIn(metadata, PERSON)).toEqual({
      '@id': PERSON,
      '@type': 'Person',
      conformsTo: { '@id': 'https://w3id.org/ldac/profile#Person' },
      name: 'Jane Smith',
    });
  });

  it('can have no licence on its root', async () => {
    const metadata = await metadataOf(await (await imported(crate(collection(ROOT, { licence: null }))))(ROOT));

    expect(entityIn(metadata, ROOT)).not.toHaveProperty('license');
  });
});
