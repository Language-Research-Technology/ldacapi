import { ROCrate } from 'ro-crate';
import { describe, expect, it } from 'vitest';
import { deriveUniqueEntityIds, entityClass, recordType } from './writer.ts';

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
    const paths = deriveUniqueEntityIds(crate);

    expect(paths.get(`${ROOT}/data/a b.txt`)).toBe('data/a b.txt');
    expect(paths.get(`${ROOT}/data/c%20d.txt`)).toBe('data/c d.txt');
  });

  it('maps a file whose @id already names the crate', async () => {
    const crate = await crateWith(`${ROOT}/data/a.txt`);
    const paths = deriveUniqueEntityIds(crate);

    expect(paths.get(`${ROOT}/data/a.txt`)).toBe('data/a.txt');
  });

  it('normalises a relative reference to its path', async () => {
    const crate = await crateWith('./data/a.txt?v=1');
    const paths = deriveUniqueEntityIds(crate);

    expect(paths.get(`${ROOT}/./data/a.txt?v=1`)).toBe('data/a.txt');
  });

  it('keeps a path it can’t decode as it is', async () => {
    const crate = await crateWith('data/100%.txt');
    const paths = deriveUniqueEntityIds(crate);

    expect(paths.get(`${ROOT}/data/100%.txt`)).toBe('data/100%.txt');
  });

  it('has no path for a file outside the crate', async () => {
    const crate = await crateWith('https://example.org/a.wav');
    const paths = deriveUniqueEntityIds(crate);

    expect(paths.get('https://example.org/a.wav')).toBeUndefined();
  });

  it('keeps paths when indexers rename the same crate again', async () => {
    const crate = await crateWith('a.txt');
    deriveUniqueEntityIds(crate);
    const paths = deriveUniqueEntityIds(crate);

    expect(paths.get(`${ROOT}/a.txt`)).toBe('a.txt');
  });
});

const crateOf = (context: unknown, ...entities: Record<string, unknown>[]) =>
  ROCrate.create({
    '@context': context,
    '@graph': [{ '@id': 'ro-crate-metadata.json', '@type': 'CreativeWork', about: { '@id': ROOT } }, { '@id': ROOT, '@type': 'Dataset' }, ...entities],
  });

describe('recordType', () => {
  it('is an indexed type the entity conforms to the profile of', async () => {
    const crate = await crateOf('https://w3id.org/ro/crate/1.1/context', {
      '@id': '#alice',
      '@type': 'Person',
      conformsTo: { '@id': 'https://w3id.org/ldac/profile#Person' },
    });

    expect(recordType(crate.getEntity('#alice'))).toBe('Person');
  });

  it('is none when the entity doesn’t conform to its type’s profile', async () => {
    const crate = await crateOf('https://w3id.org/ro/crate/1.1/context', { '@id': '#alice', '@type': 'Person' });

    expect(recordType(crate.getEntity('#alice'))).toBeUndefined();
  });
});

describe('entityClass', () => {
  it('is the class the crate’s context names', async () => {
    expect(entityClass(await crateOf('https://w3id.org/ro/crate/1.1/context'), 'Person')).toBe('http://schema.org/Person');
  });

  it('falls back to the type’s profile when the context doesn’t name a class', async () => {
    expect(entityClass(await crateOf([{}]), 'Person')).toBe('https://w3id.org/ldac/profile#Person');
  });
});
