import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type Shape = 'one-crate' | 'split';

export const SHAPES: readonly Shape[] = ['one-crate', 'split'];

export type CollectionSize = {
  /** Sub-collections under the top collection */
  collections: number;
  objectsPerCollection: number;
  /** Each object's files: one text transcript, the rest audio */
  filesPerObject: number;
};

/** 30,031 entities: split, that's 3,031 crates */
export const FULL_SIZE: CollectionSize = { collections: 30, objectsPerCollection: 100, filesPerObject: 9 };

export type GenerateOptions = CollectionSize & { shape: Shape; seed?: number };

const TOP = 'arcp://name,benchmark';
const OPEN_LICENCE = 'https://creativecommons.org/licenses/by/4.0/';
const RESTRICTED_LICENCE = 'https://example.org/licences/benchmark-restricted/';
const AUTHOR = 'https://example.org/people/benchmark-author';
const LANGUAGE = 'https://glottolog.org/resource/languoid/id/stan1293';
const PROFILE = 'https://w3id.org/ldac/profile';

const KB = 1024;
const MB = 1024 * KB;
const AUDIO_BYTES = KB;

/** The text transcript's size for the `index`th object across the collection */
const transcriptSize = (index: number) => (index % 1000 === 0 ? 5 * MB : index % 100 === 1 ? MB : 50 * KB);

const WORDS = ['the', 'river', 'country', 'story', 'old', 'people', 'went', 'down', 'to', 'camp', 'water', 'kangaroo', 'song', 'and', 'then', 'we'];

/** mulberry32: a small seeded generator, so the same seed gives the same bytes */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

function text(size: number, seed: number) {
  const next = random(seed);
  const words: string[] = [];
  let length = 0;
  while (length < size) {
    const word = WORDS[Math.floor(next() * WORDS.length)] as string;
    const separator = next() < 0.08 ? '\n' : ' ';
    words.push(word, separator);
    length += word.length + 1;
  }
  return words.join('').slice(0, size);
}

function audio(seed: number) {
  const next = random(seed);
  return Buffer.from(Array.from({ length: AUDIO_BYTES }, () => Math.floor(next() * 256)));
}

type Entity = Record<string, unknown> & { '@id': string };
type FileContent = { path: string; content: string | Buffer };

const ref = (id: string) => ({ '@id': id });

const pad = (n: number, of: number) => String(n + 1).padStart(String(of).length, '0');

const CONTEXT_ENTITIES: Entity[] = [
  { '@id': OPEN_LICENCE, '@type': 'OrganizationReuseLicense', name: 'Attribution 4.0 International (CC BY 4.0)' },
  { '@id': RESTRICTED_LICENCE, '@type': 'OrganizationReuseLicense', name: 'Benchmark restricted licence' },
  { '@id': AUTHOR, '@type': 'Person', name: 'Benchmark Author' },
  { '@id': LANGUAGE, '@type': 'Language', name: 'English', languageCode: 'stan1293' },
];

const descriptor = (rootId: string): Entity => ({
  '@id': 'ro-crate-metadata.json',
  '@type': 'CreativeWork',
  conformsTo: ref('https://w3id.org/ro/crate/1.1'),
  about: ref(rootId),
  license: ref(OPEN_LICENCE),
});

const crateJson = (rootId: string, entities: Entity[]) =>
  JSON.stringify(
    {
      '@context': ['https://w3id.org/ro/crate/1.1/context', 'https://w3id.org/ldac/context', { '@vocab': 'http://schema.org/' }],
      '@graph': [descriptor(rootId), ...entities, ...CONTEXT_ENTITIES],
    },
    null,
    2,
  );

const collection = (id: string, name: string, parent?: string): Entity => ({
  '@id': id,
  '@type': ['Dataset', 'RepositoryCollection'],
  conformsTo: ref(`${PROFILE}#Collection`),
  name,
  description: `${name}, generated for the indexing benchmark`,
  license: ref(OPEN_LICENCE),
  author: ref(AUTHOR),
  datePublished: '2026-01-01',
  inLanguage: ref(LANGUAGE),
  ...(parent && { 'pcdm:memberOf': ref(parent) }),
});

/** An object and its files, the files' ids prefixed by `pathPrefix` */
function object(id: string, name: string, parent: string, index: number, filesPerObject: number, seed: number, pathPrefix: string) {
  const transcript = `${pathPrefix}transcript.txt`;
  const transcriptContent = text(transcriptSize(index), seed * 1_000_003 + index);
  const files: Entity[] = [
    {
      '@id': transcript,
      '@type': 'File',
      name: `${name} transcript`,
      encodingFormat: 'text/plain',
      contentSize: String(transcriptContent.length),
      inLanguage: ref(LANGUAGE),
    },
  ];
  const contents: FileContent[] = [{ path: transcript, content: transcriptContent }];
  for (let n = 1; n < filesPerObject; n++) {
    const path = `${pathPrefix}recording-${pad(n - 1, filesPerObject - 1)}.wav`;
    files.push({ '@id': path, '@type': 'File', name: `${name} recording ${n}`, encodingFormat: 'audio/x-wav', contentSize: String(AUDIO_BYTES) });
    contents.push({ path, content: audio(seed * 1_000_003 + index * filesPerObject + n) });
  }
  const entity: Entity = {
    '@id': id,
    '@type': ['Dataset', 'RepositoryObject'],
    conformsTo: ref(`${PROFILE}#Object`),
    name,
    description: `${name}, generated for the indexing benchmark`,
    license: ref(index % 10 === 9 ? RESTRICTED_LICENCE : OPEN_LICENCE),
    author: ref(AUTHOR),
    datePublished: '2026-01-01',
    inLanguage: ref(LANGUAGE),
    'ldac:communicationMode': ref('ldac:SpokenLanguage'),
    'ldac:linguisticGenre': ref('ldac:Narrative'),
    'ldac:indexableText': ref(transcript),
    'pcdm:memberOf': ref(parent),
    hasPart: files.map((file) => ref(file['@id'])),
  };
  return { entities: [entity, ...files], contents };
}

async function writeFiles(dir: string, contents: FileContent[]) {
  for (const { path, content } of contents) {
    const file = join(dir, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
  }
}

async function writeCrate(dir: string, rootId: string, entities: Entity[], contents: FileContent[] = []) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'ro-crate-metadata.json'), crateJson(rootId, entities));
  await writeFiles(dir, contents);
}

/** Writes the benchmark collection as crate directories under `dir`; the same options give byte-identical crates */
export async function generateCollection(dir: string, options: GenerateOptions) {
  const { shape, collections, objectsPerCollection, filesPerObject, seed = 1 } = options;
  const split = shape === 'split';
  const oneCrate = [collection(TOP, 'Benchmark collection')];
  let crates = 0;
  let entities = 1;

  if (split) {
    await writeCrate(join(dir, 'collection'), TOP, oneCrate);
    crates++;
  }
  for (let c = 0; c < collections; c++) {
    const collectionName = `collection-${pad(c, collections)}`;
    const collectionId = `${TOP}/${collectionName}`;
    const sub = collection(collectionId, `Benchmark sub-collection ${c + 1}`, TOP);
    entities++;
    if (split) {
      await writeCrate(join(dir, collectionName), collectionId, [sub]);
      crates++;
    } else {
      oneCrate.push(sub);
    }
    for (let o = 0; o < objectsPerCollection; o++) {
      const objectName = `object-${pad(o, objectsPerCollection)}`;
      const objectId = `${collectionId}/${objectName}`;
      const index = c * objectsPerCollection + o;
      const name = `Benchmark object ${index + 1}`;
      const parts = object(objectId, name, collectionId, index, filesPerObject, seed, split ? '' : `${collectionName}/${objectName}/`);
      entities += parts.entities.length;
      if (split) {
        await writeCrate(join(dir, `${collectionName}-${objectName}`), objectId, parts.entities, parts.contents);
        crates++;
      } else {
        oneCrate.push(...parts.entities);
        await writeFiles(join(dir, 'collection'), parts.contents);
      }
    }
  }
  if (!split) {
    await writeCrate(join(dir, 'collection'), TOP, oneCrate);
    crates++;
  }
  return { crates, entities };
}

/** Writes the collection in each of `shapes` under `dir`/<shape>, printing what each holds */
export async function generateShapes(dir: string, shapes: readonly Shape[], size: Omit<GenerateOptions, 'shape'>, print: (line: string) => void) {
  for (const shape of shapes) {
    const out = join(dir, shape);
    const { crates, entities } = await generateCollection(out, { ...size, shape });
    print(`${shape}: ${crates} crates, ${entities} entities in ${out}`);
  }
}
