import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildTestApp, type TestApp } from '../../test/app.ts';
import { generateCookieKey, generateSigningKey } from '../oidc/keys.ts';

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
    expect((await app.inject({ method: 'GET', url: '/admin/', headers: { host: 'admin.localhost:8080' } })).statusCode).toBe(404);
    expect(logs.map(({ msg }) => msg)).toContainEqual(expect.stringContaining('OIDC_UPSTREAM_ISSUER'));
  });
});

describe('the admin pages in production without ADMIN_ORIGIN', () => {
  it('are not found, and startup warns that they are off', async () => {
    vi.resetModules();
    const started = await buildTestApp({
      NODE_ENV: 'production',
      LOG_LEVEL: 'warn',
      OPENSEARCH_URL: 'http://localhost:9200',
      OCFL_ROOT: 'storage/ocfl',
      OIDC_ISSUER: 'https://api.example.org',
      OIDC_CLIENTS: JSON.stringify([{ client_id: 'oni', redirect_uris: ['https://oni.example.org/callback'] }]),
      OIDC_UPSTREAM_ISSUER: 'https://idp.example.org',
      OIDC_UPSTREAM_CLIENT_ID: 'ldacapi',
      OIDC_UPSTREAM_CLIENT_SECRET: 'secret',
      OIDC_SIGNING_KEYS: JSON.stringify({ keys: [generateSigningKey()] }),
      OIDC_COOKIE_KEYS: generateCookieKey(),
      ADMIN_USERS: 'alice@upstream',
    });
    try {
      for (const host of ['api.example.org', 'admin.localhost:8080']) {
        expect((await started.app.inject({ method: 'GET', url: '/admin/', headers: { host } })).statusCode).toBe(404);
      }
      expect(logs.map(({ msg }) => msg)).toContainEqual(expect.stringContaining('ADMIN_ORIGIN'));
    } finally {
      await started.app.close();
      await started.prisma.$disconnect();
    }
  });
});
