import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildTestApp, type TestApp } from '../../test/app.ts';
import { startFakeUpstream } from '../../test/fake-upstream.ts';

const logs = vi.hoisted(() => [] as { level: number; msg: string }[]);

vi.mock('../logger.ts', async () => {
  const { pino } = await import('pino');
  const stream = new Writable({
    write(chunk, _encoding, done) {
      logs.push(JSON.parse(chunk.toString()));
      done();
    },
  });
  return { logger: pino({ level: 'error' }, stream) };
});

let app: TestApp;
let prisma: Awaited<ReturnType<typeof buildTestApp>>['prisma'];

beforeAll(async () => {
  const upstream = await startFakeUpstream({ clientId: 'ldacapi', clientSecret: 'secret' });
  await upstream.close();

  ({ app, prisma } = await buildTestApp({
    OIDC_ISSUER: 'http://localhost:8080',
    OIDC_CLIENTS: JSON.stringify([{ client_id: 'oni', redirect_uris: ['http://localhost:5173/callback'] }]),
    OIDC_UPSTREAM_ISSUER: upstream.issuer,
    OIDC_UPSTREAM_CLIENT_ID: 'ldacapi',
    OIDC_UPSTREAM_CLIENT_SECRET: 'secret',
  }));
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe('starting with an upstream provider that is down', () => {
  it('logs an error naming OIDC_UPSTREAM_ISSUER and keeps running', async () => {
    await app.ready();

    await vi.waitFor(() => expect(logs.map(({ msg }) => msg)).toContainEqual(expect.stringContaining('OIDC_UPSTREAM_ISSUER')));
    expect((await app.inject({ method: 'GET', url: '/.well-known/openid-configuration' })).statusCode).toBe(200);
  });
});
