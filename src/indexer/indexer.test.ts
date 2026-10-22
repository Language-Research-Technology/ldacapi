import { ROCrate } from 'ro-crate';
import { describe, expect, it } from 'vitest';
import { Indexer } from './indexer.ts';

const ROOT = 'arcp://name,test';

const crateWith = (...ids: string[]) =>
  ROCrate.create({
    '@context': 'https://w3id.org/ro/crate/1.1/context',
    '@graph': [
      { '@id': 'ro-crate-metadata.json', '@type': 'CreativeWork', about: { '@id': ROOT } },
      { '@id': ROOT, '@type': 'Dataset', hasPart: ids.map((id) => ({ '@id': id })) },
      ...ids.map((id) => ({ '@id': id, '@type': 'File' })),
    ],
  });

describe('deriveUniqueEntityIds', () => {
  it('maps a renamed file to its path in the crate, decoded', async () => {
    const crate = await crateWith('data/a b.txt', 'data/c%20d.txt');
    const paths = new Indexer().deriveUniqueEntityIds(crate);

    expect(paths.get(`${ROOT}/data/a b.txt`)).toBe('data/a b.txt');
    expect(paths.get(`${ROOT}/data/c%20d.txt`)).toBe('data/c d.txt');
  });

  it('maps a file whose @id already names the crate', async () => {
    const crate = await crateWith(`${ROOT}/data/a.txt`);
    const paths = new Indexer().deriveUniqueEntityIds(crate);

    expect(paths.get(`${ROOT}/data/a.txt`)).toBe('data/a.txt');
  });

  it('normalises a relative reference to its path', async () => {
    const crate = await crateWith('./data/a.txt?v=1');
    const paths = new Indexer().deriveUniqueEntityIds(crate);

    expect(paths.get(`${ROOT}/./data/a.txt?v=1`)).toBe('data/a.txt');
  });

  it('has no path for a file outside the crate', async () => {
    const crate = await crateWith('https://example.org/a.wav');
    const paths = new Indexer().deriveUniqueEntityIds(crate);

    expect(paths.get('https://example.org/a.wav')).toBeUndefined();
  });

  it('keeps paths when indexers rename the same crate again', async () => {
    const crate = await crateWith('a.txt');
    new Indexer().deriveUniqueEntityIds(crate);
    const paths = new Indexer().deriveUniqueEntityIds(crate);

    expect(paths.get(`${ROOT}/a.txt`)).toBe('a.txt');
  });
});
