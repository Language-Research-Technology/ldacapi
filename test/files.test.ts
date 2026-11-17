import { beforeAll, describe, expect, it } from 'vitest';
import { ocflTestbed } from './app.ts';
import { collection, crate, file, fileDescribedButNotHeld } from './crate-builder.ts';

const ROOT = 'arcp://name,files';
const HELD = `${ROOT}/held.txt`;
const NOT_HELD = `${ROOT}/not-held.txt`;

const testbed = ocflTestbed(
  crate(collection(ROOT, { hasPart: ['held.txt', 'not-held.txt'] }), [
    file('held.txt', { content: 'Held words', encodingFormat: 'text/plain' }),
    fileDescribedButNotHeld('not-held.txt', { name: 'Absent transcript', encodingFormat: 'text/plain', contentSize: '2048' }),
  ]),
);

const get = (id: string) => testbed.started.app.inject({ method: 'GET', url: `${testbed.started.config.prefix}/file/${encodeURIComponent(id)}` });

beforeAll(async () => {
  await testbed.indexOnly(ROOT);
});

describe('a file described but not held', () => {
  it('answers 404 for its content, unlike a file the crate holds', async () => {
    expect((await get(NOT_HELD)).statusCode).toBe(404);
    expect((await get(HELD)).statusCode).toBe(200);
  });

  it('is searchable', async () => {
    const { entities } = await testbed.search({ query: 'Absent' });

    expect(entities.map(({ id }: { id: string }) => id)).toEqual([NOT_HELD]);
  });
});
