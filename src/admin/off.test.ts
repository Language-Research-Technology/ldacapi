import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildTestApp, type TestApp } from '../../test/app.ts';

const logs = vi.hoisted(() => [] as { level: number; msg: string }[]);

vi.mock('../logger.ts', async () => {
  const { pino } = await import('pino');
  const stream = new Writable({
    write(chunk, _encoding, done) {
      logs.push(JSON.parse(chunk.toString()));
      done();
    },
  });
  return { logger: pino({ level: 'warn' }, stream) };
});

let app: TestApp;
let prisma: Awaited<ReturnType<typeof buildTestApp>>['prisma'];

beforeAll(async () => {
  ({ app, prisma } = await buildTestApp({ ADMIN_USERS: 'alice@upstream' }));
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe('the admin pages without sign-in', () => {
  it('are not found, and startup warns that they are off', async () => {
    expect((await app.inject({ method: 'GET', url: '/admin/' })).statusCode).toBe(404);
    expect(logs.map(({ msg }) => msg)).toContainEqual(expect.stringContaining('OIDC_UPSTREAM_ISSUER'));
  });
});
