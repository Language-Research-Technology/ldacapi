import { ROCrate } from 'ro-crate';
import { describe, expect, it } from 'vitest';
import { type CrateObject, Indexer } from './indexer.ts';
import { searchDocument } from './search.ts';

const ROOT = 'arcp://name,test';
const LICENSE = 'https://creativecommons.org/licenses/by/4.0/';

const crateWith = async (entity: Record<string, unknown>, terms: Record<string, string> = {}) => {
  const crate = await ROCrate.create({
    '@context': ['https://w3id.org/ro/crate/1.1/context', { '@vocab': 'http://schema.org/', ldac: 'https://w3id.org/ldac/terms#', ...terms }],
    '@graph': [
      { '@id': 'ro-crate-metadata.json', '@type': 'CreativeWork', about: { '@id': ROOT }, license: { '@id': LICENSE } },
      { '@id': ROOT, '@type': ['Dataset', 'RepositoryCollection'], name: 'Root', hasPart: [{ '@id': 'data.txt' }] },
      { '@id': '#lang', '@type': 'Language', name: 'English' },
      { '@id': '#place', '@type': 'Place', geo: { '@id': '#point' } },
      { '@id': '#point', '@type': 'Geometry', asWKT: 'POINT(153.02 -27.47)' },
      { '@id': 'data.txt', '@type': 'File', name: 'Data', encodingFormat: 'text/plain', ...entity },
    ],
  });
  const paths = new Indexer().deriveUniqueEntityIds(crate);
  const id = `${ROOT}/data.txt`;
  return { crate, entity: crate.getEntity(id), path: paths.get(id) };
};

const crateObject: CrateObject = { id: '', root: '/', text: async () => 'hello world', file: async () => ({ size: 11, crc32: '' }) };

describe('searchDocument', () => {
  it('flattens an entity into declared fields', async () => {
    const { crate, entity, path } = await crateWith({
      inLanguage: { '@id': '#lang' },
      'ldac:communicationMode': { '@id': 'https://w3id.org/ldac/terms#SpokenLanguage' },
      datePublished: '2001/2005',
      contentLocation: { '@id': '#place' },
    });

    expect(await searchDocument(crate, crateObject, entity, LICENSE, ROOT, path)).toMatchObject({
      id: `${ROOT}/data.txt`,
      name: 'Data',
      entityType: 'http://schema.org/MediaObject',
      recordType: 'File',
      inLanguage: ['English'],
      communicationMode: ['https://w3id.org/ldac/terms#SpokenLanguage'],
      encodingFormat: ['text/plain'],
      rootCollection: ROOT,
      license: LICENSE,
      datePublished: '2001',
      location: { lat: -27.47, lng: 153.02 },
      text: 'hello world',
    });
  });

  it.each([
    [['Dataset', 'RepositoryCollection'], 'https://w3id.org/ldac/profile#Collection', 'Collection'],
    [['Dataset', 'RepositoryObject'], 'https://w3id.org/ldac/profile#Object', 'Object'],
    ['Person', 'https://w3id.org/ldac/profile#Person', 'Person'],
    ['Organization', 'https://w3id.org/ldac/profile#Organization', 'Organisation'],
    ['SoftwareApplication', 'https://w3id.org/ldac/profile#SoftwareApplication', 'Software Application'],
  ])('labels a %s record as %s', async (type, profile, label) => {
    const { crate, entity } = await crateWith({ '@type': type, conformsTo: { '@id': profile } });

    expect((await searchDocument(crate, crateObject, entity, LICENSE, ROOT)).recordType).toBe(label);
  });

  it.each([
    ['http://schema.org/Thing', 'Thing'],
    ['https://example.com/terms#Widget', 'Widget'],
  ])('labels an unknown class %s by its last segment', async (uri, label) => {
    const { crate, entity } = await crateWith({}, { File: uri });

    const doc = await searchDocument(crate, crateObject, entity, LICENSE, ROOT);

    expect(doc).toMatchObject({ entityType: uri, recordType: label });
  });

  it('has no type field', async () => {
    const { crate, entity } = await crateWith({});

    expect(await searchDocument(crate, crateObject, entity, LICENSE, ROOT)).not.toHaveProperty('type');
  });

  it('leaves out dates it cannot store', async () => {
    const { crate, entity } = await crateWith({ datePublished: 'circa 1900', dateCreated: ['1901-02-03', 'unknown'] });

    const doc = await searchDocument(crate, crateObject, entity, LICENSE, ROOT);

    expect(doc).not.toHaveProperty('datePublished');
    expect(doc.dateCreated).toEqual(['1901-02-03']);
  });
});
