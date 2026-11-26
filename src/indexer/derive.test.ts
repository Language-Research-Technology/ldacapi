import { spawnSync } from 'node:child_process';
import { ROCrate } from 'ro-crate';
import { describe, expect, it } from 'vitest';
import { type Crate, collection, crate, fileDescribedButNotHeld, licence, object, type Part, person } from '../../test/crate-builder.ts';
import { type DeriveFacts, derive } from './derive.ts';

const ROOT = 'arcp://name,derive';
const CC_BY = 'https://creativecommons.org/licenses/by/4.0/';
const RESTRICTED = 'https://example.org/licenses/restricted';
const SPOKEN = 'https://w3id.org/ldac/terms#SpokenLanguage';

const facts: DeriveFacts = {
  parentCrates: [],
  defaultLicense: '',
  defaultMetadataLicense: '',
  isOpenLicence: (id) => id === CC_BY,
  heldFiles: new Map(),
};

const derived = async (built: Crate, given: Partial<DeriveFacts> = {}) => derive(await ROCrate.create(built.metadata), { ...facts, ...given });

const fileRows = async (built: Crate, given: Partial<DeriveFacts> = {}) => (await derived(built, given)).entities.flatMap(({ file }) => (file ? [file] : []));

type Derived = { row: { id: string; meta: { rocrate: unknown } } };

/** The entities of an entity's virtual crate */
const graphOf = (entity: Derived) => (entity.row.meta.rocrate as { '@graph': Record<string, unknown>[] })['@graph'];

/** The root entity of an entity's virtual crate */
const virtualRoot = (entity: Derived) => graphOf(entity).find(({ '@id': id }) => id === entity.row.id);

const entityOf = async (built: Crate, id: string, given: Partial<DeriveFacts> = {}) => {
  const found = (await derived(built, given)).entities.find(({ row }) => row.id === id);
  if (!found) {
    throw new Error(`No entity ${id}`);
  }
  return found;
};

const ids = async (built: Crate) => (await derived(built)).entities.map(({ row }) => row.id).sort();

const NOTHING = { collections: 0, objects: 0, subCollections: 0, files: 0, language: [], communicationMode: [], mediaType: [] };

/** The crate's aggregates by entity id */
const aggregates = async (built: Crate, given: Partial<DeriveFacts> = {}) =>
  Object.fromEntries((await derived(built, given)).aggregates.map(({ entityId, ...aggregate }) => [entityId, aggregate]));

const thing = (id: string, type: string | string[], profile?: string, properties: Record<string, unknown> = {}): Part => ({
  entity: { '@id': id, '@type': type, ...(profile && { conformsTo: { '@id': `https://w3id.org/ldac/profile#${profile}` } }), ...properties },
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

  describe('shared entities', () => {
    it('are people, organisations and software; collections, objects and files are held by their crate', async () => {
      const built = crate(collection(ROOT), [
        object(`${ROOT}/object`),
        person('#alice'),
        thing('#acme', 'Organization', 'Organization'),
        thing('#tool', 'SoftwareApplication', 'SoftwareApplication'),
        fileDescribedButNotHeld('a.txt'),
      ]);

      const shared = (await derived(built)).entities.filter((entity) => entity.shared).map(({ row }) => row.id);

      expect(shared.sort()).toEqual([`${ROOT}/#alice`, `${ROOT}/#acme`, `${ROOT}/#tool`].sort());
    });

    it('win first from a crate whose metadata licence is open', async () => {
      expect((await derived(crate(collection(ROOT)))).openMetadata).toBe(true);
      expect((await derived(crate(collection(ROOT), [], { metadataLicence: RESTRICTED }))).openMetadata).toBe(false);
    });
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

      const derivation = await derived(built, { heldFiles: new Map([['a.txt', 1]]) });

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
      const derivation = await derived(built, { parentCrates: [TOP] });

      for (const id of [ROOT, `${ROOT}/object`, `${ROOT}/a.txt`]) {
        const { row, document } = derivation.entities.find((entity) => entity.row.id === id) ?? {};
        expect([row?.rootCollection, document?.rootCollection]).toEqual([TOP, TOP]);
      }
    });

    it('is null for the top collection itself', async () => {
      const { row, document } = await entityOf(built, ROOT, { parentCrates: [] });

      expect(row.rootCollection).toBeNull();
      expect(document).not.toHaveProperty('rootCollection');
    });

    it('is null for people, organisations and software', async () => {
      const derivation = await derived(built, { parentCrates: [TOP] });

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
      const built = crate(collection(ROOT), [], { metadataLicence: null });

      expect((await entityOf(built, ROOT, { defaultMetadataLicense: RESTRICTED })).row.metadataLicenseId).toBe(RESTRICTED);
    });

    it('can’t be resolved for a crate with none and no default, which fails', async () => {
      await expect(derived(crate(collection(ROOT), [], { metadataLicence: null }))).rejects.toThrow(
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

      const graph = graphOf(await entityOf(built, `${ROOT}/object`));

      expect(graph.find((entity) => entity['@id'] === `${ROOT}/object`)).toMatchObject({
        memberOf: [{ '@id': ROOT }],
        'ldac:linguisticGenre': ['Narrative'],
      });
    });
  });

  describe('rule 11, files described but not held', () => {
    it('gives the file a file row with no place in the crate, sized as stated or 0', async () => {
      const built = crate(collection(ROOT), [
        fileDescribedButNotHeld('data/a%20b.wav', { contentSize: '14384 bytes' }),
        fileDescribedButNotHeld('https://example.org/media/c.wav', { contentSize: 163840 }),
        fileDescribedButNotHeld('unknown.wav', { contentSize: 'unknown' }),
        fileDescribedButNotHeld('unstated.wav'),
      ]);

      expect((await fileRows(built)).map(({ id, size, path }) => ({ id, size, path }))).toEqual([
        { id: `${ROOT}/data/a%20b.wav`, size: 14384, path: undefined },
        { id: 'https://example.org/media/c.wav', size: 163840, path: undefined },
        { id: `${ROOT}/unknown.wav`, size: 0, path: undefined },
        { id: `${ROOT}/unstated.wav`, size: 0, path: undefined },
      ]);
    });

    it('gives it the media type application/octet-stream when none is stated', async () => {
      const built = crate(collection(ROOT), [fileDescribedButNotHeld('a.wav'), fileDescribedButNotHeld('b.wav', { encodingFormat: 'audio/wav' })]);

      expect((await fileRows(built)).map(({ mediaType }) => mediaType)).toEqual(['application/octet-stream', 'audio/wav']);
    });

    it('still gives it a row and a document, but no text', async () => {
      const built = crate(collection(ROOT), [fileDescribedButNotHeld('a.txt', { name: 'Absent', encodingFormat: 'text/plain' })]);

      const entity = await entityOf(built, `${ROOT}/a.txt`);

      expect([entity.row.name, entity.document.name, entity.textPath]).toEqual(['Absent', 'Absent', undefined]);
    });

    it('hides it in its virtual crate with display: false, unlike a file the crate holds', async () => {
      const built = crate(collection(ROOT), [fileDescribedButNotHeld('absent.wav'), fileDescribedButNotHeld('held.wav')]);
      const given = { heldFiles: new Map([['held.wav', 10]]) };

      expect(virtualRoot(await entityOf(built, `${ROOT}/absent.wav`, given))).toMatchObject({ display: false });
      expect(virtualRoot(await entityOf(built, `${ROOT}/held.wav`, given))).not.toHaveProperty('display');
    });

    it('warns once for the crate, with the count of such files', async () => {
      const built = crate(collection(ROOT), [fileDescribedButNotHeld('a.wav'), fileDescribedButNotHeld('b.wav'), fileDescribedButNotHeld('held.wav')]);

      const { warnings } = await derived(built, { heldFiles: new Map([['held.wav', 10]]) });

      expect(warnings).toEqual([{ msg: 'Files described but not held', count: 2 }]);
    });

    it('doesn’t warn for a crate that holds every file it describes', async () => {
      const built = crate(collection(ROOT), [fileDescribedButNotHeld('held.wav')]);

      expect((await derived(built, { heldFiles: new Map([['held.wav', 10]]) })).warnings).toEqual([]);
    });
  });

  describe('rule 13, aggregates contribution', () => {
    it('counts the collections, objects, direct sub-collections and files below each entity, not the entity itself', async () => {
      const built = crate(collection(ROOT, { hasMember: [`${ROOT}/sub`, `${ROOT}/loose`] }), [
        collection(`${ROOT}/sub`, { memberOf: ROOT }),
        collection(`${ROOT}/sub/deeper`, { memberOf: `${ROOT}/sub` }),
        object(`${ROOT}/sub/deeper/object`, { memberOf: `${ROOT}/sub/deeper`, hasPart: ['a.wav', 'b.wav'] }),
        fileDescribedButNotHeld('a.wav', { isPartOf: `${ROOT}/sub/deeper/object` }),
        fileDescribedButNotHeld('b.wav', { isPartOf: `${ROOT}/sub/deeper/object` }),
        object(`${ROOT}/loose`, { memberOf: ROOT }),
        fileDescribedButNotHeld('c.wav'),
      ]);

      const found = await aggregates(built, { heldFiles: new Map([['a.wav', 10]]) });

      expect(found).toEqual({
        [ROOT]: { ...NOTHING, collections: 2, objects: 2, subCollections: 1, files: 2 },
        [`${ROOT}/sub`]: { ...NOTHING, collections: 1, objects: 1, subCollections: 1, files: 2 },
        [`${ROOT}/sub/deeper`]: { ...NOTHING, objects: 1, files: 2 },
        [`${ROOT}/sub/deeper/object`]: { ...NOTHING, files: 2 },
        [`${ROOT}/a.wav`]: NOTHING,
        [`${ROOT}/b.wav`]: NOTHING,
        [`${ROOT}/loose`]: NOTHING,
        [`${ROOT}/c.wav`]: NOTHING,
      });
    });

    it('lists the languages, communication modes and media types at or below each entity, by their search facet labels', async () => {
      const built = crate(collection(ROOT, { inLanguage: { '@id': '#greek' } }), [
        thing('#english', 'Language', undefined, { name: 'English' }),
        thing('#greek', 'Language', undefined, { name: 'Greek' }),
        thing('#spoken', 'DefinedTerm', undefined, { name: 'Spoken' }),
        object(`${ROOT}/object`, { memberOf: ROOT, inLanguage: { '@id': '#english' }, 'ldac:communicationMode': { '@id': '#spoken' } }),
        fileDescribedButNotHeld('a.wav', { isPartOf: `${ROOT}/object`, encodingFormat: 'audio/wav', inLanguage: { '@id': '#english' } }),
        fileDescribedButNotHeld('a.txt', { isPartOf: `${ROOT}/object`, encodingFormat: 'text/plain' }),
      ]);

      const found = await aggregates(built);

      expect(found[ROOT]).toMatchObject({ language: ['English', 'Greek'], communicationMode: ['Spoken'], mediaType: ['audio/wav', 'text/plain'] });
      expect(found[`${ROOT}/object`]).toMatchObject({ language: ['English'], communicationMode: ['Spoken'], mediaType: ['audio/wav', 'text/plain'] });
      expect(found[`${ROOT}/a.wav`]).toMatchObject({ language: ['English'], communicationMode: [], mediaType: ['audio/wav'] });
    });

    it('adds the crate to each ancestor in its parent crates', async () => {
      const PARENT = 'arcp://name,parent';
      const TOP = 'arcp://name,top';
      const built = crate(collection(ROOT, { memberOf: PARENT, inLanguage: 'Greek' }), [
        object(`${ROOT}/object`, { memberOf: ROOT, hasPart: ['a.wav'] }),
        fileDescribedButNotHeld('a.wav', { isPartOf: `${ROOT}/object`, encodingFormat: 'audio/wav' }),
      ]);

      const found = await aggregates(built, { parentCrates: [PARENT, TOP] });

      const below = { collections: 1, objects: 1, files: 1, language: ['Greek'], mediaType: ['audio/wav'] };
      expect(found[PARENT]).toEqual({ ...NOTHING, ...below, subCollections: 1 });
      expect(found[TOP]).toEqual({ ...NOTHING, ...below });
    });

    it('adds to the collection the crate’s root is a member of, even when its crate can’t be read', async () => {
      const built = crate(collection(ROOT, { memberOf: 'arcp://name,unreadable' }));

      expect(await aggregates(built)).toEqual({ [ROOT]: NOTHING, 'arcp://name,unreadable': { ...NOTHING, collections: 1, subCollections: 1 } });
    });

    it('gives people, organisations and software nothing, which reads as zero counts and empty lists', async () => {
      const built = crate(collection(ROOT, { author: { '@id': '#alice' } }), [
        person('#alice', { inLanguage: 'English' }),
        thing('#acme', 'Organization', 'Organization'),
        thing('#tool', 'SoftwareApplication', 'SoftwareApplication'),
      ]);

      expect(await aggregates(built)).toEqual({ [ROOT]: NOTHING });
    });

    it('stops at a cycle of members', async () => {
      const built = crate(collection(ROOT), [collection(`${ROOT}/a`, { memberOf: `${ROOT}/b` }), collection(`${ROOT}/b`, { memberOf: `${ROOT}/a` })]);

      const found = await aggregates(built);

      expect([found[`${ROOT}/a`], found[`${ROOT}/b`]]).toEqual([
        { ...NOTHING, collections: 1, subCollections: 1 },
        { ...NOTHING, collections: 1, subCollections: 1 },
      ]);
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
        meta: { accessControl: 'Public' },
      });
      expect(row.meta).not.toHaveProperty('crateId');
      const rocrate = row.meta.rocrate as { '@context': unknown; '@graph': Record<string, unknown>[] };
      expect(rocrate['@context']).toEqual(built.metadata['@context']);
      expect(rocrate['@graph']).toContainEqual(
        expect.objectContaining({ '@id': `${ROOT}/#alice`, '@type': ['Person', 'Dataset'], license: CC_BY, knows: [{ '@id': '#bob' }] }),
      );
      expect(rocrate['@graph']).toContainEqual(expect.objectContaining({ '@id': '#bob', name: ['Bob'] }));
    });

    it('gives the virtual crate the crate root’s conformsTo when the entity has none', async () => {
      const built = crate(collection(ROOT), [fileDescribedButNotHeld('a.txt', { licence: RESTRICTED })]);

      const graph = graphOf(await entityOf(built, `${ROOT}/a.txt`));

      expect(graph.find((entity) => entity['@id'] === `${ROOT}/a.txt`)).toMatchObject({
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

    it('gives a file the crate holds a file row named by the end of its path, with its media type, size and place in the crate', async () => {
      const built = crate(collection(ROOT), [
        fileDescribedButNotHeld('data/a%20b.wav', { encodingFormat: [{ '@id': '#wav' }, 'audio/wav'], contentSize: '1 bytes' }),
        fileDescribedButNotHeld('100%.wav'),
        fileDescribedButNotHeld('https://example.org/media/c.wav'),
      ]);

      const files = await fileRows(built, {
        heldFiles: new Map([
          ['data/a b.wav', 14384],
          ['100%.wav', 0],
        ]),
      });

      expect(files).toEqual([
        { id: `${ROOT}/data/a%20b.wav`, filename: 'a b.wav', mediaType: 'audio/wav', size: 14384, path: 'data/a b.wav' },
        { id: `${ROOT}/100%.wav`, filename: '100%.wav', mediaType: 'application/octet-stream', size: 0, path: '100%.wav' },
        { id: 'https://example.org/media/c.wav', filename: 'c.wav', mediaType: 'application/octet-stream', size: 0 },
      ]);
    });

    it('finds a file under the crate root by its path, without query or fragment', async () => {
      const built = crate(collection(ROOT), [fileDescribedButNotHeld(`${ROOT}/./data/a.txt?v=1`), fileDescribedButNotHeld(`${ROOT}/?v=1`)]);

      const files = await fileRows(built, { heldFiles: new Map([['data/a.txt', 1]]) });

      expect(files.map(({ path }) => path)).toEqual(['data/a.txt', undefined]);
    });

    it('marks the text of a text file the crate holds for the document', async () => {
      const built = textFile({}, [
        fileDescribedButNotHeld('a.wav', { encodingFormat: 'audio/wav' }),
        fileDescribedButNotHeld('https://example.org/b.txt', { encodingFormat: 'text/plain' }),
      ]);

      const derivation = await derived(built, {
        heldFiles: new Map([
          ['data.txt', 1],
          ['a.wav', 1],
        ]),
      });

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

  describe('rule 15, what a virtual crate holds: its entity, and what it links to up to the records it reaches', () => {
    /** The entities of an entity's virtual crate other than its descriptor and root, by id */
    const linkedIn = (entity: Derived) =>
      Object.fromEntries(
        graphOf(entity)
          .filter(({ '@id': id }) => id !== entity.row.id && id !== 'ro-crate-metadata.json')
          .map((held) => [held['@id'], held]),
      );

    const linked = async (built: Crate, id: string) => linkedIn(await entityOf(built, id));

    it('holds a linked record as a stub: its id, type, name and description', async () => {
      const built = crate(
        collection(ROOT, { name: 'Root', description: 'All of it', hasPart: ['a.txt'], hasMember: [`${ROOT}/object`], datePublished: '2001' }),
        [fileDescribedButNotHeld('a.txt', { isPartOf: ROOT }), object(`${ROOT}/object`, { memberOf: ROOT })],
      );

      expect(await linked(built, `${ROOT}/a.txt`)).toEqual({
        [ROOT]: { '@id': ROOT, '@type': ['Dataset', 'RepositoryCollection'], name: ['Root'], description: ['All of it'] },
      });
    });

    it('holds a profiled person as a stub, and any other person in full, with what it links to', async () => {
      const built = crate(collection(ROOT), [
        object(`${ROOT}/object`, { author: [{ '@id': '#alice' }, { '@id': '#bob' }], licence: null }),
        person('#alice', { name: 'Alice', email: 'alice@example.org', homeLocation: { '@id': '#home' } }),
        thing('#bob', 'Person', undefined, { name: 'Bob', email: 'bob@example.org', homeLocation: { '@id': '#home' } }),
        thing('#home', 'Place', undefined, { name: 'Home' }),
      ]);

      expect(await linked(built, `${ROOT}/object`)).toEqual({
        '#alice': { '@id': '#alice', '@type': ['Person'], name: ['Alice'] },
        '#bob': { '@id': '#bob', '@type': ['Person'], name: ['Bob'], email: ['bob@example.org'], homeLocation: [{ '@id': '#home' }] },
        '#home': { '@id': '#home', '@type': ['Place'], name: ['Home'] },
      });
    });

    it('holds a linked file’s stub with its filename', async () => {
      const built = crate(collection(ROOT), [
        object(`${ROOT}/object`, { hasPart: ['a.eaf'], licence: null }),
        fileDescribedButNotHeld('a.eaf', { name: 'Annotations', filename: 'a.eaf', encodingFormat: 'application/xml' }),
      ]);

      expect((await linked(built, `${ROOT}/object`))['a.eaf']).toEqual({ '@id': 'a.eaf', '@type': ['File'], name: ['Annotations'], filename: ['a.eaf'] });
    });

    it('holds a linked language with its code, and a licence with its name and description', async () => {
      const built = crate(collection(ROOT), [
        object(`${ROOT}/object`, { inLanguage: { '@id': '#eng' }, licence: RESTRICTED }),
        thing('#eng', 'Language', undefined, { name: 'English', code: 'eng' }),
        licence(RESTRICTED, { name: 'Restricted', description: 'Ask first' }),
      ]);

      const found = await linked(built, `${ROOT}/object`);

      expect([found['#eng'], found[RESTRICTED]]).toEqual([
        { '@id': '#eng', '@type': ['Language'], name: ['English'], code: ['eng'] },
        { '@id': RESTRICTED, '@type': ['CreativeWork'], name: ['Restricted'], description: ['Ask first'] },
      ]);
    });

    it('follows links through entities that aren’t records, however far, and holds each once', async () => {
      const built = crate(collection(ROOT), [
        object(`${ROOT}/object`, { contentLocation: { '@id': '#recorded' }, spatialCoverage: { '@id': '#covered' }, licence: null }),
        thing('#recorded', 'Place', undefined, { name: 'Recorded', geo: { '@id': '#point' } }),
        thing('#point', 'Geometry', undefined, { asWKT: 'POINT(153.02 -27.47)', 'geo:hasSource': { '@id': '#survey' } }),
        thing('#survey', 'CreativeWork', undefined, { name: 'Survey', about: { '@id': '#covered' } }),
        thing('#covered', 'Place', undefined, { name: 'Covered', geo: { '@id': '#area' } }),
        thing('#area', 'Geometry', undefined, { asWKT: 'POLYGON((0 0, 1 0, 1 1, 0 0))', 'geo:hasSource': { '@id': '#survey' } }),
      ]);

      expect(await linked(built, `${ROOT}/object`)).toEqual({
        '#recorded': { '@id': '#recorded', '@type': ['Place'], name: ['Recorded'], geo: [{ '@id': '#point' }] },
        '#point': { '@id': '#point', '@type': ['Geometry'], asWKT: ['POINT(153.02 -27.47)'], 'geo:hasSource': [{ '@id': '#survey' }] },
        '#survey': { '@id': '#survey', '@type': ['CreativeWork'], name: ['Survey'], about: [{ '@id': '#covered' }] },
        '#covered': { '@id': '#covered', '@type': ['Place'], name: ['Covered'], geo: [{ '@id': '#area' }] },
        '#area': { '@id': '#area', '@type': ['Geometry'], asWKT: ['POLYGON((0 0, 1 0, 1 1, 0 0))'], 'geo:hasSource': [{ '@id': '#survey' }] },
      });
    });

    it('stops at a record reached through other entities, holding it as a stub without what it links to', async () => {
      const built = crate(collection(ROOT), [
        object(`${ROOT}/object`, { author: { '@id': '#bob' }, licence: null }),
        thing('#bob', 'Person', undefined, { name: 'Bob', affiliation: { '@id': '#acme' } }),
        thing('#acme', 'Organization', 'Organization', { name: 'Acme', location: { '@id': '#hq' } }),
        thing('#hq', 'Place', undefined, { name: 'HQ' }),
      ]);

      expect(Object.keys(await linked(built, `${ROOT}/object`)).sort()).toEqual(['#acme', '#bob']);
    });

    it('holds each object’s participants with their postcode polygons, and the collection only as a stub, in a survey-shaped crate', async () => {
      const names = ['one', 'two'];
      const participants = (n: string) => [1, 2].map((p) => `#${n}-participant-${p}`);
      const built = crate(collection(ROOT, { name: 'Survey', hasMember: names.map((n) => `${ROOT}/${n}`), contentLocation: { '@id': '#australia' } }), [
        thing('#australia', 'Place', undefined, { name: 'Australia' }),
        ...names.flatMap((n) => [
          object(`${ROOT}/${n}`, {
            memberOf: ROOT,
            hasPart: [`${n}.pdf`],
            'ldac:researchParticipant': participants(n).map((p) => ({ '@id': p })),
            licence: null,
          }),
          fileDescribedButNotHeld(`${n}.pdf`, { isPartOf: `${ROOT}/${n}` }),
          ...participants(n).flatMap((p) => [
            thing(p, 'Person', undefined, { name: p, homeLocation: { '@id': `${p}-postcode` } }),
            thing(`${p}-postcode`, 'Place', undefined, { name: '2000', geo: { '@id': `${p}-polygon` } }),
            thing(`${p}-polygon`, 'Geometry', undefined, { asWKT: 'POLYGON((151 -33, 152 -33, 152 -34, 151 -33))' }),
          ]),
        ]),
      ]);

      const byId = new Map((await derived(built)).entities.map((entity) => [entity.row.id, entity]));

      for (const n of names) {
        const held = linkedIn(byId.get(`${ROOT}/${n}`) as Derived);
        const reached = participants(n).flatMap((p) => [p, `${p}-postcode`, `${p}-polygon`]);
        expect(Object.keys(held).sort()).toEqual([ROOT, `${n}.pdf`, ...reached].sort());
        expect(held[ROOT]).toEqual({ '@id': ROOT, '@type': ['Dataset', 'RepositoryCollection'], name: ['Survey'] });
        expect(Object.keys(linkedIn(byId.get(`${ROOT}/${n}.pdf`) as Derived))).toEqual([`${ROOT}/${n}`]);
      }
    });

    it('leaves a link to an entity the crate doesn’t describe, or to its descriptor, as a reference alone', async () => {
      const built = crate(collection(ROOT), [
        object(`${ROOT}/object`, { citation: [{ '@id': 'https://example.org/paper' }, { '@id': 'ro-crate-metadata.json' }], licence: null }),
      ]);

      const entity = await entityOf(built, `${ROOT}/object`);

      expect(virtualRoot(entity)).toMatchObject({ citation: [{ '@id': 'https://example.org/paper' }, { '@id': 'ro-crate-metadata.json' }] });
      expect(linkedIn(entity)).toEqual({});
    });

    it('holds no second copy of an entity that links to itself, or that an entity it reaches links back to', async () => {
      const built = crate(collection(ROOT), [
        person('#alice', { name: 'Alice', sameAs: { '@id': '#alice' }, knowsAbout: { '@id': '#topic' } }),
        thing('#topic', 'DefinedTerm', undefined, { name: 'Topic', subjectOf: { '@id': '#alice' } }),
      ]);

      const entity = await entityOf(built, `${ROOT}/#alice`);

      expect(virtualRoot(entity)).toMatchObject({ sameAs: [{ '@id': '#alice' }] });
      expect(Object.keys(linkedIn(entity))).toEqual(['#topic']);
    });

    it('takes the crate root’s conformsTo as references alone, holding nothing the profile links to', async () => {
      const built = crate(collection(ROOT), [
        fileDescribedButNotHeld('a.txt'),
        thing('https://w3id.org/ldac/profile#Collection', 'Profile', undefined, { name: 'Collection', author: { '@id': '#ldac' } }),
        thing('#ldac', 'Organization', undefined, { name: 'LDaC' }),
      ]);

      const entity = await entityOf(built, `${ROOT}/a.txt`);

      expect(virtualRoot(entity)).toMatchObject({ conformsTo: [{ '@id': 'https://w3id.org/ldac/profile#Collection' }] });
      expect(linkedIn(entity)).toEqual({});
    });

    it('types its root a Dataset once', async () => {
      const built = crate(collection(ROOT), [fileDescribedButNotHeld('a.txt')]);

      expect((await derived(built)).entities.map((entity) => virtualRoot(entity)?.['@type'])).toEqual([
        ['Dataset', 'RepositoryCollection'],
        ['File', 'Dataset'],
      ]);
    });
  });

  describe('rule 16, a copy of a collection above the crate: left out, with a warning, as its own crate holds it', () => {
    const FAMILY = 'arcp://name,top/family';
    const TOP = 'arcp://name,top';
    const LANGUAGE = `${FAMILY}/language`;
    const parentCrates = [FAMILY, TOP];

    it.each([
      ['the top collection', collection(TOP), TOP, 'RepositoryCollection'],
      ['the parent collection', collection(FAMILY), FAMILY, 'RepositoryCollection'],
      ['the parent collection, as an object', object(FAMILY), FAMILY, 'RepositoryObject'],
    ])('leaves out a copy of %s, naming its type', async (_, copy, copied, recordType) => {
      const built = crate(object(LANGUAGE, { memberOf: FAMILY }), [copy]);

      const derivation = await derived(built, { parentCrates });

      expect(derivation.entities.map(({ row }) => [row.id, row.memberOf])).toEqual([[LANGUAGE, FAMILY]]);
      expect(derivation.warnings).toEqual([{ msg: 'Describes a collection above it, which its own crate holds; left out', entityId: copied, recordType }]);
    });

    it.each([
      ['a profiled', collection(FAMILY, { licence: CC_BY }), 1],
      ['an unprofiled', thing(FAMILY, ['Dataset', 'RepositoryCollection'], undefined, { license: { '@id': CC_BY } }), 0],
    ])('gives the crate’s records no licence from %s copy, warning only of a record', async (_, copy, warned) => {
      const built = crate(object(LANGUAGE, { memberOf: FAMILY, licence: null }), [copy]);

      const derivation = await derived(built, { parentCrates, defaultLicense: RESTRICTED });

      expect(derivation.entities.map(({ row }) => [row.id, row.contentLicenseId, row.meta.accessControl])).toEqual([
        [LANGUAGE, RESTRICTED, 'AuthorizationByApplication'],
      ]);
      expect(derivation.warnings).toHaveLength(warned);
    });

    it('adds nothing to aggregates, so the crate still counts below every ancestor', async () => {
      const built = crate(object(LANGUAGE, { memberOf: FAMILY, hasPart: ['a.txt'] }), [
        collection(FAMILY, { inLanguage: 'Copied' }),
        fileDescribedButNotHeld('a.txt', { isPartOf: LANGUAGE }),
      ]);

      const found = await aggregates(built, { parentCrates });

      const below = { ...NOTHING, objects: 1, files: 1 };
      expect(found[FAMILY]).toEqual(below);
      expect(found[TOP]).toEqual(below);
    });

    it('keeps a collection that isn’t above the crate, so a claim on another crate’s collection still clashes', async () => {
      const SIBLING = `${TOP}/sibling`;
      const built = crate(object(LANGUAGE, { memberOf: FAMILY }), [collection(SIBLING, { memberOf: TOP })]);

      const derivation = await derived(built, { parentCrates });

      expect(derivation.entities.map(({ row }) => row.id).sort()).toEqual([LANGUAGE, SIBLING].sort());
      expect(derivation.warnings).toEqual([]);
    });
  });
});
