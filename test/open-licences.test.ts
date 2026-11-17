import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, ocflStorage } from './app.ts';
import { collection, crate, file } from './crate-builder.ts';

const ROOT = 'arcp://name,open-licences';
const OPEN = 'https://example.org/licenses/open-here';
// Open in the default test configuration, but not in this deployment's list
const CLOSED = 'https://creativecommons.org/licenses/by/4.0/';
const OPEN_FILE = `${ROOT}/open.txt`;
const CLOSED_FILE = `${ROOT}/closed.txt`;

const { ocflRoot } = ocflStorage({
  crates: [
    crate(
      collection(ROOT, { name: 'open licences', licence: OPEN, hasPart: ['open.txt', 'closed.txt'] }),
      [
        file('open.txt', { content: 'open', encodingFormat: 'text/plain' }),
        file('closed.txt', { content: 'closed', encodingFormat: 'text/plain', licence: CLOSED }),
      ],
      { metadataLicence: OPEN },
    ),
  ],
});

let started: Awaited<ReturnType<typeof buildTestApp>>;

const get = (path: string) => started.app.inject({ method: 'GET', url: `${started.config.prefix}${path}` });
const accessControl = async (id: string) => (await get(`/entity/${encodeURIComponent(id)}`)).json().accessControl;
const fileStatus = async (id: string) => (await get(`/file/${encodeURIComponent(id)}`)).statusCode;

beforeAll(async () => {
  started = await buildTestApp({ OCFL_ROOT: ocflRoot(), LOG_LEVEL: 'silent', OPEN_LICENSES: OPEN }, { ocfl: true });
  await started.emptyEverything();
  await started.indexQueue.index(ROOT);
  await started.workTheQueue();
});

afterAll(async () => {
  await started?.emptyEverything();
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
