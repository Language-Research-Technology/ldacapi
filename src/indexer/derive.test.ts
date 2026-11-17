import { spawnSync } from 'node:child_process';
import { ROCrate } from 'ro-crate';
import { describe, expect, it } from 'vitest';
import { type Crate, collection, crate, fileDescribedButNotHeld, object, type Part, person } from '../../test/crate-builder.ts';
import { type DeriveFacts, derive } from './derive.ts';

const ROOT = 'arcp://name,derive';
const CC_BY = 'https://creativecommons.org/licenses/by/4.0/';
const RESTRICTED = 'https://example.org/licenses/restricted';
const SPOKEN = 'https://w3id.org/ldac/terms#SpokenLanguage';

const facts: DeriveFacts = { topCollection: ROOT, defaultLicense: '', defaultMetadataLicense: '', isOpenLicence: (id) => id === CC_BY };

const derived = async (built: Crate, given: Partial<DeriveFacts> = {}) => derive(await ROCrate.create(built.metadata), { ...facts, ...given });

const entityOf = async (built: Crate, id: string, given: Partial<DeriveFacts> = {}) => {
  const found = (await derived(built, given)).entities.find(({ row }) => row.id === id);
  if (!found) {
    throw new Error(`No entity ${id}`);
  }
  return found;
};

const ids = async (built: Crate) => (await derived(built)).entities.map(({ row }) => row.id).sort();

const thing = (id: string, type: string | string[], profile?: string, properties: Record<string, unknown> = {}): Part => ({
  entity: { '@id': id, '@type': type, ...(profile && { conformsTo: { '@id': `https://w3id.org/ldac/profile#${profile}` } }), ...properties },
});

/** `built` without the metadata descriptor's licence */
const withoutMetadataLicence = (built: Crate): Crate => ({
  ...built,
  metadata: {
    ...built.metadata,
    '@graph': built.metadata['@graph'].map(({ license, ...entity }) => (entity['@id'] === 'ro-crate-metadata.json' ? entity : { ...entity, license })),
  },
});

describe('derivation', () => {
  it('loads with no configuration, so reads neither it nor the database', () => {
    const loaded = spawnSync('node', ['--input-type=module', '-e', "await import('./src/indexer/derive.ts')"], {
      env: { PATH: process.env.PATH },
      encoding: 'utf8',
    });

    expect(loaded.stderr).toBe('');
    expect(loaded.status).toBe(0);
  });

  it('rule 1, entities indexed by profile: profiled collections, objects, people, organisations and software, and every file', async () => {
    const built = crate(collection(ROOT), [
      object(`${ROOT}/object`),
      person('#alice'),
      thing('#acme', 'Organization', 'Organization'),
      thing('#tool', 'SoftwareApplication', 'SoftwareApplication'),
      fileDescribedButNotHeld('a.txt'),
      thing('#bob', 'Person'),
      thing('#unprofiled', ['Dataset', 'RepositoryObject']),
      thing('#place', 'Place'),
    ]);

    expect(await ids(built)).toEqual([ROOT, `${ROOT}/object`, `${ROOT}/#alice`, `${ROOT}/#acme`, `${ROOT}/#tool`, `${ROOT}/a.txt`].sort());
  });

  describe('rule 2, parent of a collection or object', () => {
    it('is its pcdm:memberOf', async () => {
      const built = crate(collection(ROOT, { hasMember: [`${ROOT}/sub`] }), [
        collection(`${ROOT}/sub`, { memberOf: `${ROOT}/other` }),
        collection(`${ROOT}/other`),
      ]);

      expect((await entityOf(built, `${ROOT}/sub`)).row.memberOf).toBe(`${ROOT}/other`);
    });

    it('is else what has it by pcdm:hasMember', async () => {
      const built = crate(collection(ROOT, { hasMember: [`${ROOT}/object`] }), [object(`${ROOT}/object`)]);

      const { row, document } = await entityOf(built, `${ROOT}/object`);

      expect(row.memberOf).toBe(ROOT);
      expect(document.memberOf).toBe(ROOT);
    });

    it('is none for a collection that is a member of nothing', async () => {
      const { row, document } = await entityOf(crate(collection(ROOT)), ROOT);

      expect(row.memberOf).toBeNull();
      expect(document).not.toHaveProperty('memberOf');
    });

    it('doesn’t come from isPartOf or hasPart, and a person has none', async () => {
      const built = crate(collection(ROOT, { hasPart: [`${ROOT}/object`] }), [
        object(`${ROOT}/object`, { isPartOf: { '@id': ROOT } }),
        person('#alice', { 'pcdm:memberOf': { '@id': ROOT } }),
      ]);

      expect((await entityOf(built, `${ROOT}/object`)).row.memberOf).toBeNull();
      expect((await entityOf(built, `${ROOT}/#alice`)).row.memberOf).toBeNull();
    });
  });

  describe('rule 3, parent of a file', () => {
    it('is what it is part of, preferring an object', async () => {
      const built = crate(collection(ROOT, { hasPart: ['a.txt'] }), [
        object(`${ROOT}/object`, { memberOf: ROOT }),
        fileDescribedButNotHeld('a.txt', { isPartOf: `${ROOT}/object` }),
      ]);

      const derivation = await derived(built);

      expect(derivation.entities.find(({ row }) => row.id === `${ROOT}/a.txt`)?.row.memberOf).toBe(`${ROOT}/object`);
      expect(derivation.warnings).toEqual([]);
    });

    it('is else what has it by hasPart', async () => {
      const built = crate(collection(ROOT), [object('#object', { hasPart: ['a.txt'] }), fileDescribedButNotHeld('a.txt')]);

      expect((await entityOf(built, `${ROOT}/a.txt`)).row.memberOf).toBe(`${ROOT}/#object`);
    });

    it('is anything it is part of when no object has it', async () => {
      const built = crate(collection(ROOT, { hasPart: ['a.txt'] }), [fileDescribedButNotHeld('a.txt')]);

      expect((await entityOf(built, `${ROOT}/a.txt`)).row.memberOf).toBe(ROOT);
    });
  });

  it('rule 4, several candidate parents: the first wins, with a warning', async () => {
    const built = crate(collection(ROOT), [
      object(`${ROOT}/object`, { 'pcdm:memberOf': [{ '@id': `${ROOT}/first` }, { '@id': `${ROOT}/second` }] }),
      collection(`${ROOT}/first`),
      collection(`${ROOT}/second`),
    ]);

    const derivation = await derived(built);

    expect(derivation.entities.find(({ row }) => row.id === `${ROOT}/object`)?.row.memberOf).toBe(`${ROOT}/first`);
    expect(derivation.warnings).toEqual([
      { msg: 'Several candidate parents; using the first', entityId: `${ROOT}/object`, parents: [`${ROOT}/first`, `${ROOT}/second`] },
    ]);
  });

  describe('rule 5, root collection', () => {
    const TOP = 'arcp://name,top';
    const built = crate(collection(ROOT, { memberOf: TOP }), [
      object(`${ROOT}/object`, { memberOf: ROOT }),
      fileDescribedButNotHeld('a.txt', { isPartOf: `${ROOT}/object` }),
      person('#alice'),
      thing('#acme', 'Organization', 'Organization'),
      thing('#tool', 'SoftwareApplication', 'SoftwareApplication'),
    ]);

    it('is the top collection found from the parent crates, for collections, objects and files', async () => {
      const derivation = await derived(built, { topCollection: TOP });

      for (const id of [ROOT, `${ROOT}/object`, `${ROOT}/a.txt`]) {
        const { row, document } = derivation.entities.find((entity) => entity.row.id === id) ?? {};
        expect([row?.rootCollection, document?.rootCollection]).toEqual([TOP, TOP]);
      }
    });

    it('is null for the top collection itself', async () => {
      const { row, document } = await entityOf(built, ROOT, { topCollection: ROOT });

      expect(row.rootCollection).toBeNull();
      expect(document).not.toHaveProperty('rootCollection');
    });

    it('is null for people, organisations and software', async () => {
      const derivation = await derived(built, { topCollection: TOP });

      const unplaced = derivation.entities.filter(({ row }) => ['#alice', '#acme', '#tool'].some((id) => row.id === `${ROOT}/${id}`));
      expect(unplaced.map(({ row }) => row.rootCollection)).toEqual([null, null, null]);
    });
  });

  describe('rule 6, entity ids', () => {
    it('puts a relative or blank-node id under the crate root’s, and keeps an id under the root or an absolute IRI', async () => {
      const built = crate(collection(ROOT), [
        person('#alice'),
        person('_:b0'),
        fileDescribedButNotHeld('data/a.txt'),
        object(`${ROOT}/object`),
        person('https://orcid.org/0000-0001'),
      ]);

      expect(await ids(built)).toEqual([ROOT, `${ROOT}/#alice`, `${ROOT}/_:b0`, `${ROOT}/data/a.txt`, `${ROOT}/object`, 'https://orcid.org/0000-0001'].sort());
    });

    it('gives a blank-node id in two crates two entities', async () => {
      const OTHER = 'arcp://name,other';

      const blankIn = async (crateId: string) => (await ids(crate(collection(crateId), [person('_:b0')]))).filter((id) => id.endsWith('_:b0'));

      expect([...(await blankIn(ROOT)), ...(await blankIn(OTHER))]).toEqual([`${ROOT}/_:b0`, `${OTHER}/_:b0`]);
    });

    it('can’t be given for a crate whose root id isn’t absolute, which fails', async () => {
      await expect(derived(crate(collection('./')))).rejects.toThrow("The crate's root id, ./, isn't an absolute IRI");
    });

    it('names a parent by its id', async () => {
      const built = crate(collection(ROOT), [object('#object'), fileDescribedButNotHeld('a.txt', { isPartOf: '#object' })]);

      expect((await entityOf(built, `${ROOT}/a.txt`)).row.memberOf).toBe(`${ROOT}/#object`);
    });
  });

  describe('rule 7, content licence', () => {
    it('is the entity’s own', async () => {
      const built = crate(collection(ROOT), [fileDescribedButNotHeld('a.txt', { licence: RESTRICTED, isPartOf: ROOT })]);

      const { row, document } = await entityOf(built, `${ROOT}/a.txt`);

      expect([row.contentLicenseId, document.license]).toEqual([RESTRICTED, RESTRICTED]);
    });

    it('is else the nearest ancestor’s in the crate, so an object without one inherits its collection’s', async () => {
      const built = crate(collection(ROOT), [
        collection(`${ROOT}/sub`, { memberOf: ROOT, licence: RESTRICTED }),
        object(`${ROOT}/object`, { memberOf: `${ROOT}/sub` }),
        fileDescribedButNotHeld('a.txt', { isPartOf: `${ROOT}/object` }),
      ]);

      expect((await entityOf(built, `${ROOT}/object`)).row.contentLicenseId).toBe(RESTRICTED);
      expect((await entityOf(built, `${ROOT}/a.txt`)).row.contentLicenseId).toBe(RESTRICTED);
    });

    it('is else the crate root’s, also when the ancestors go round in a circle', async () => {
      const built = crate(collection(ROOT, { licence: RESTRICTED }), [
        collection(`${ROOT}/a`, { memberOf: `${ROOT}/b` }),
        collection(`${ROOT}/b`, { memberOf: `${ROOT}/a` }),
        person('#alice'),
      ]);

      expect((await entityOf(built, `${ROOT}/a`)).row.contentLicenseId).toBe(RESTRICTED);
      expect((await entityOf(built, `${ROOT}/#alice`)).row.contentLicenseId).toBe(RESTRICTED);
    });

    it('is else the default', async () => {
      const built = crate(collection(ROOT, { licence: null }), [person('#alice')]);

      expect((await entityOf(built, `${ROOT}/#alice`, { defaultLicense: RESTRICTED })).row.contentLicenseId).toBe(RESTRICTED);
    });

    it('can’t be resolved for a crate with no root licence and no default, which fails', async () => {
      const built = crate(collection(ROOT, { licence: null }), [person('#alice', { license: { '@id': CC_BY } })]);

      await expect(derived(built)).rejects.toThrow('The crate has no licence, and none is configured as the default');
    });
  });

  describe('rule 8, metadata licence', () => {
    it('is the metadata descriptor’s, for every entity', async () => {
      const built = crate(collection(ROOT), [fileDescribedButNotHeld('a.txt', { licence: CC_BY })], { metadataLicence: RESTRICTED });

      expect((await derived(built)).entities.map(({ row }) => row.metadataLicenseId)).toEqual([RESTRICTED, RESTRICTED]);
    });

    it('is else the default', async () => {
      const built = withoutMetadataLicence(crate(collection(ROOT)));

      expect((await entityOf(built, ROOT, { defaultMetadataLicense: RESTRICTED })).row.metadataLicenseId).toBe(RESTRICTED);
    });

    it('can’t be resolved for a crate with none and no default, which fails', async () => {
      await expect(derived(withoutMetadataLicence(crate(collection(ROOT))))).rejects.toThrow(
        'The crate has no metadata licence, and none is configured as the default',
      );
    });
  });

  it('rule 9, access control label: Public for an open content licence, AuthorizationByApplication otherwise', async () => {
    const built = crate(collection(ROOT), [fileDescribedButNotHeld('a.txt', { licence: RESTRICTED, isPartOf: ROOT })]);

    expect((await entityOf(built, ROOT)).row.meta.accessControl).toBe('Public');
    expect((await entityOf(built, `${ROOT}/a.txt`)).row.meta.accessControl).toBe('AuthorizationByApplication');
  });

  describe('rule 10, spellings', () => {
    it('reads LDaC properties only when prefixed', async () => {
      const built = crate(collection(ROOT), [
        object(`${ROOT}/prefixed`, { 'ldac:communicationMode': { '@id': SPOKEN } }),
        object(`${ROOT}/bare`, { communicationMode: { '@id': SPOKEN } }),
      ]);

      expect((await entityOf(built, `${ROOT}/prefixed`)).document.communicationMode).toEqual([SPOKEN]);
      expect((await entityOf(built, `${ROOT}/bare`)).document.communicationMode).toEqual([]);
    });

    it('indexes a crate on the bare spelling without parents or LDaC facets, and with no warning', async () => {
      const built = crate(thing(ROOT, ['Dataset', 'RepositoryCollection'], 'Collection', { hasMember: [{ '@id': `${ROOT}/a` }] }), [
        thing(`${ROOT}/a`, ['Dataset', 'RepositoryObject'], 'Object', {
          memberOf: { '@id': ROOT },
          linguisticGenre: { '@id': 'https://w3id.org/ldac/terms#Narrative' },
        }),
        thing(`${ROOT}/b`, ['Dataset', 'RepositoryObject'], 'Object', { memberOf: [{ '@id': ROOT }, { '@id': `${ROOT}/a` }] }),
      ]);

      const derivation = await derived(built);

      expect(derivation.entities.map(({ row }) => row.memberOf)).toEqual([null, null, null]);
      expect(derivation.entities.map(({ document }) => document.linguisticGenre)).toEqual([[], [], []]);
      expect(derivation.warnings).toEqual([]);
    });

    it('serves property names as deposited in the virtual crate', async () => {
      const built = crate(collection(ROOT), [
        thing(`${ROOT}/object`, ['Dataset', 'RepositoryObject'], 'Object', { memberOf: { '@id': ROOT }, 'ldac:linguisticGenre': 'Narrative' }),
      ]);

      const rocrate = (await entityOf(built, `${ROOT}/object`)).row.meta.rocrate as { '@graph': Record<string, unknown>[] };

      expect(rocrate['@graph'].find((entity) => entity['@id'] === `${ROOT}/object`)).toMatchObject({
        memberOf: [{ '@id': ROOT }],
        'ldac:linguisticGenre': ['Narrative'],
      });
    });
  });

  describe('rule 14, row and document contents', () => {
    /** `built` with `terms` added to its context */
    const withTerms = (built: Crate, terms: Record<string, string>): Crate => ({
      ...built,
      metadata: { ...built.metadata, '@context': [...(built.metadata['@context'] as unknown[]), terms] },
    });

    const textFile = (properties: Record<string, unknown> = {}, parts: Part[] = []) =>
      crate(collection(ROOT, { hasPart: ['data.txt'] }), [
        thing('#lang', 'Language', undefined, { name: 'English' }),
        thing('#place', 'Place', undefined, { geo: { '@id': '#point' } }),
        thing('#point', 'Geometry', undefined, { asWKT: 'POINT(153.02 -27.47)' }),
        fileDescribedButNotHeld('data.txt', { name: 'Data', encodingFormat: 'text/plain', ...properties }),
        ...parts,
      ]);

    const fileIn = async (built: Crate) => entityOf(built, `${ROOT}/data.txt`);

    it('gives a row with names and descriptions joined, the class, and the virtual crate', async () => {
      const built = crate(collection(ROOT, { name: 'Root' }), [
        thing('#alice', 'Person', 'Person', { name: ['Alice', 'Al'], description: ['One', 'Two'], knows: { '@id': '#bob' } }),
        thing('#bob', 'Person', undefined, { name: 'Bob' }),
      ]);

      const { row } = await entityOf(built, `${ROOT}/#alice`);

      expect(row).toMatchObject({
        id: `${ROOT}/#alice`,
        name: 'Alice; Al',
        description: 'One; Two',
        entityType: 'http://schema.org/Person',
        metadataLicenseId: CC_BY,
        meta: { crateId: ROOT, accessControl: 'Public' },
      });
      const rocrate = row.meta.rocrate as { '@context': unknown; '@graph': Record<string, unknown>[] };
      expect(rocrate['@context']).toEqual(built.metadata['@context']);
      expect(rocrate['@graph']).toContainEqual(
        expect.objectContaining({ '@id': `${ROOT}/#alice`, '@type': ['Person', 'Dataset'], license: CC_BY, knows: [{ '@id': '#bob' }] }),
      );
      expect(rocrate['@graph']).toContainEqual(expect.objectContaining({ '@id': '#bob', name: ['Bob'] }));
    });

    it('gives the virtual crate the crate root’s conformsTo when the entity has none', async () => {
      const built = crate(collection(ROOT), [fileDescribedButNotHeld('a.txt', { licence: RESTRICTED })]);

      const rocrate = (await entityOf(built, `${ROOT}/a.txt`)).row.meta.rocrate as { '@graph': Record<string, unknown>[] };

      expect(rocrate['@graph'].find((entity) => entity['@id'] === `${ROOT}/a.txt`)).toMatchObject({
        conformsTo: [{ '@id': 'https://w3id.org/ldac/profile#Collection' }],
        license: [{ '@id': RESTRICTED }],
      });
    });

    it('names an entity without a name by its id, with an empty description', async () => {
      const { row, document } = await entityOf(crate(collection(ROOT), [person('#alice')]), `${ROOT}/#alice`);

      expect([row.name, row.description, document.name]).toEqual([`${ROOT}/#alice`, '', `${ROOT}/#alice`]);
    });

    it('names the crate by its root, or not at all', async () => {
      expect((await derived(crate(collection(ROOT, { name: 'Root' })))).name).toBe('Root');
      expect((await derived(crate(thing(ROOT, ['Dataset', 'RepositoryCollection'], 'Collection')))).name).toBeNull();
      expect((await derived(crate(thing(ROOT, ['Dataset', 'RepositoryCollection'], 'Collection', { name: 1984 })))).name).toBeNull();
    });

    it('gives a file a file row named by the end of its path, with its media type and stated size', async () => {
      const built = crate(collection(ROOT), [
        fileDescribedButNotHeld('data/a%20b.wav', { encodingFormat: [{ '@id': '#wav' }, 'audio/wav'], contentSize: '14384 bytes' }),
        fileDescribedButNotHeld('https://example.org/media/c.wav', { contentSize: 163840 }),
        fileDescribedButNotHeld('unknown.wav', { contentSize: 'unknown' }),
        fileDescribedButNotHeld('100%.wav'),
      ]);

      const files = (await derived(built)).entities.flatMap(({ file }) => (file ? [file] : []));

      expect(files).toEqual([
        { id: `${ROOT}/data/a%20b.wav`, filename: 'a b.wav', mediaType: 'audio/wav', statedSize: 14384, path: 'data/a b.wav' },
        { id: 'https://example.org/media/c.wav', filename: 'c.wav', mediaType: 'application/octet-stream', statedSize: 163840 },
        { id: `${ROOT}/unknown.wav`, filename: 'unknown.wav', mediaType: 'application/octet-stream', statedSize: -1, path: 'unknown.wav' },
        { id: `${ROOT}/100%.wav`, filename: '100%.wav', mediaType: 'application/octet-stream', statedSize: -1, path: '100%.wav' },
      ]);
    });

    it('gives a file under the crate root its path, without query or fragment', async () => {
      const built = crate(collection(ROOT), [fileDescribedButNotHeld(`${ROOT}/./data/a.txt?v=1`), fileDescribedButNotHeld(`${ROOT}/?v=1`)]);

      const files = (await derived(built)).entities.flatMap(({ file }) => (file ? [file] : []));

      expect(files.map(({ path }) => path)).toEqual(['data/a.txt', undefined]);
    });

    it('marks the text of a text file in the crate for the document', async () => {
      const built = textFile({}, [
        fileDescribedButNotHeld('a.wav', { encodingFormat: 'audio/wav' }),
        fileDescribedButNotHeld('https://example.org/b.txt', { encodingFormat: 'text/plain' }),
      ]);

      const derivation = await derived(built);

      expect(derivation.entities.flatMap(({ textPath }) => (textPath ? [textPath] : []))).toEqual(['data.txt']);
    });

    it('flattens an entity into the search fields', async () => {
      const built = textFile({
        inLanguage: { '@id': '#lang' },
        'ldac:communicationMode': { '@id': SPOKEN },
        'ldac:linguisticGenre': 'Narrative',
        'ldac:annotationType': 'Transcription',
        datePublished: '2001/2005',
        contentLocation: { '@id': '#place' },
      });

      expect((await fileIn(built)).document).toEqual({
        id: `${ROOT}/data.txt`,
        name: 'Data',
        description: [],
        entityType: 'http://schema.org/MediaObject',
        recordType: 'File',
        inLanguage: ['English'],
        communicationMode: [SPOKEN],
        linguisticGenre: ['Narrative'],
        annotationType: ['Transcription'],
        encodingFormat: ['text/plain'],
        rootCollection: ROOT,
        memberOf: ROOT,
        license: CC_BY,
        datePublished: '2001',
        dateCreated: [],
        temporalCoverage: [],
        location: { lat: -27.47, lng: 153.02 },
      });
    });

    it.each([
      [['Dataset', 'RepositoryCollection'], 'Collection', 'Collection'],
      [['Dataset', 'RepositoryObject'], 'Object', 'Object'],
      ['Person', 'Person', 'Person'],
      ['Organization', 'Organization', 'Organisation'],
      ['SoftwareApplication', 'SoftwareApplication', 'Software Application'],
    ])('labels a %s record as %s', async (type, profile, label) => {
      const built = crate(collection(ROOT), [thing('#it', type, profile)]);

      expect((await entityOf(built, `${ROOT}/#it`)).document.recordType).toBe(label);
    });

    it.each(['http://schema.org/MediaObject', 'https://schema.org/MediaObject'])('labels %s as File, whichever the scheme', async (uri) => {
      expect((await fileIn(withTerms(textFile(), { File: uri }))).document).toMatchObject({ entityType: uri, recordType: 'File' });
    });

    it.each([
      ['http://schema.org/Thing', 'Thing'],
      ['https://example.com/terms#Widget', 'Widget'],
    ])('labels an unknown class %s by its last segment', async (uri, label) => {
      expect((await fileIn(withTerms(textFile(), { File: uri }))).document).toMatchObject({ entityType: uri, recordType: label });
    });

    it('falls back to the type’s profile when the context doesn’t name a class', async () => {
      const built = crate(collection(ROOT), [person('#alice')]);
      const bare: Crate = { ...built, metadata: { ...built.metadata, '@context': [{}] } };

      expect((await entityOf(bare, `${ROOT}/#alice`)).row.entityType).toBe('https://w3id.org/ldac/profile#Person');
    });

    it('leaves out literals that aren’t text', async () => {
      expect((await fileIn(textFile({ inLanguage: [42, { '@id': '#lang' }] }))).document.inLanguage).toEqual(['English']);
    });

    it('takes the first point it finds among the entity’s places', async () => {
      const built = textFile({ spatialCoverage: ['Somewhere', { '@id': '#nowhere' }, { '@id': '#latlng' }] }, [
        thing('#nowhere', 'Place', undefined, { geo: [5, 'no point here', { '@id': '#empty' }] }),
        thing('#empty', 'Geometry'),
        thing('#latlng', 'Place', undefined, { latitude: '-33.87', longitude: '151.21' }),
      ]);

      expect((await fileIn(built)).document.location).toEqual({ lat: -33.87, lng: 151.21 });
    });

    it('leaves out dates it can’t store', async () => {
      const { document } = await fileIn(textFile({ datePublished: 'circa 1900', dateCreated: ['1901-02-03', 'unknown'], temporalCoverage: '1900/1910' }));

      expect(document).not.toHaveProperty('datePublished');
      expect([document.dateCreated, document.temporalCoverage]).toEqual([['1901-02-03'], ['1900']]);
    });
  });
});
