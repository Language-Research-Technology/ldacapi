import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, ocflRepository, ocflStorage } from './app.ts';

const ROOT = 'arcp://name,open-licences';
const OPEN = 'https://example.org/licenses/open-here';
// Open in the default test configuration, but not in this deployment's list
const CLOSED = 'https://creativecommons.org/licenses/by/4.0/';
const OPEN_FILE = `${ROOT}/open.txt`;
const CLOSED_FILE = `${ROOT}/closed.txt`;

const crate = {
  '@context': ['https://w3id.org/ro/crate/1.1/context', 'https://w3id.org/ldac/context', { '@vocab': 'http://schema.org/' }],
  '@graph': [
    { '@id': 'ro-crate-metadata.json', '@type': 'CreativeWork', license: { '@id': OPEN }, about: { '@id': ROOT } },
    {
      '@id': ROOT,
      '@type': ['Dataset', 'RepositoryCollection'],
      conformsTo: { '@id': 'https://w3id.org/ldac/profile#Collection' },
      name: 'open licences',
      license: { '@id': OPEN },
      hasPart: [{ '@id': 'open.txt' }, { '@id': 'closed.txt' }],
    },
    { '@id': 'open.txt', '@type': 'File', encodingFormat: 'text/plain' },
    { '@id': 'closed.txt', '@type': 'File', encodingFormat: 'text/plain', license: { '@id': CLOSED } },
  ],
};

const { ocflRoot } = ocflStorage({
  source: async (scratch) => {
    const source = join(scratch, 'crates', 'open-licences');
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'ro-crate-metadata.json'), JSON.stringify(crate));
    await writeFile(join(source, 'open.txt'), 'open');
    await writeFile(join(source, 'closed.txt'), 'closed');
    return join(scratch, 'crates');
  },
});

let started: Awaited<ReturnType<typeof buildTestApp>>;

const get = (path: string) => started.app.inject({ method: 'GET', url: `${started.config.prefix}${path}` });
const accessControl = async (id: string) => (await get(`/entity/${encodeURIComponent(id)}`)).json().accessControl;
const fileStatus = async (id: string) => (await get(`/file/${encodeURIComponent(id)}`)).statusCode;

beforeAll(async () => {
  started = await buildTestApp({ OCFL_ROOT: ocflRoot(), LOG_LEVEL: 'silent', OPEN_LICENSES: OPEN }, { repository: ocflRepository });
  await started.repository.deleteIndex();
  await started.repository.createIndex(ROOT);
});

afterAll(async () => {
  await started?.repository.deleteIndex();
  await started?.app.close();
  await started?.prisma.$disconnect();
});

describe('open licences, as OPEN_LICENSES lists them', () => {
  it('label an entity Public when indexed, and serve its content to anyone', async () => {
    expect(await accessControl(OPEN_FILE)).toBe('Public');
    expect(await fileStatus(OPEN_FILE)).toBe(200);
  });

  it('label an entity under any other licence AuthorizationByApplication, and refuse its content to anyone', async () => {
    expect(await accessControl(CLOSED_FILE)).toBe('AuthorizationByApplication');
    expect(await fileStatus(CLOSED_FILE)).toBe(401);
  });
});
