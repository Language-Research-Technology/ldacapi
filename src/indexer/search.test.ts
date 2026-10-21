import { ROCrate } from 'ro-crate';
import { describe, expect, it } from 'vitest';
import type { CrateObject } from './indexer.ts';
import { searchDocument } from './search.ts';

const ROOT = 'arcp://name,test';
const LICENSE = 'https://creativecommons.org/licenses/by/4.0/';

const crateWith = async (entity: Record<string, unknown>) => {
  const crate = await ROCrate.create({
    '@context': ['https://w3id.org/ro/crate/1.1/context', { '@vocab': 'http://schema.org/', ldac: 'https://w3id.org/ldac/terms#' }],
    '@graph': [
      { '@id': 'ro-crate-metadata.json', '@type': 'CreativeWork', about: { '@id': ROOT }, license: { '@id': LICENSE } },
      { '@id': ROOT, '@type': ['Dataset', 'RepositoryCollection'], name: 'Root', hasPart: [{ '@id': 'data.txt' }] },
      { '@id': '#lang', '@type': 'Language', name: 'English' },
      { '@id': '#place', '@type': 'Place', geo: { '@id': '#point' } },
      { '@id': '#point', '@type': 'Geometry', asWKT: 'POINT(153.02 -27.47)' },
      { '@id': 'data.txt', '@type': 'File', name: 'Data', encodingFormat: 'text/plain', ...entity },
    ],
  });
  return { crate, entity: crate.getEntity('data.txt') };
};

const crateObject: CrateObject = { root: '/', text: async () => 'hello world', file: async () => ({ size: 11, crc32: '' }) };

describe('searchDocument', () => {
  it('flattens an entity into declared fields', async () => {
    const { crate, entity } = await crateWith({
      inLanguage: { '@id': '#lang' },
      'ldac:communicationMode': { '@id': 'https://w3id.org/ldac/terms#SpokenLanguage' },
      datePublished: '2001/2005',
      contentLocation: { '@id': '#place' },
    });

    expect(await searchDocument(crate, crateObject, entity, LICENSE)).toMatchObject({
      id: 'data.txt',
      name: 'Data',
      type: ['File'],
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

  it('leaves out dates it cannot store', async () => {
    const { crate, entity } = await crateWith({ datePublished: 'circa 1900', dateCreated: ['1901-02-03', 'unknown'] });

    const doc = await searchDocument(crate, crateObject, entity, LICENSE);

    expect(doc).not.toHaveProperty('datePublished');
    expect(doc.dateCreated).toEqual(['1901-02-03']);
  });
});
