import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startFakeUpstream } from '../../test/fake-upstream.ts';
import type { Repository } from '../repository.ts';

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

let app: ReturnType<typeof import('../app.ts').buildApp>;
let prisma: typeof import('../prisma.ts').prisma;

const repository = { storage: () => ({ content: {} }) } as unknown as Repository;

beforeAll(async () => {
  const upstream = await startFakeUpstream({ clientId: 'ldacapi', clientSecret: 'secret' });
  await upstream.close();

  process.env.OIDC_ISSUER = 'http://localhost:8080';
  process.env.OIDC_UPSTREAM_ISSUER = upstream.issuer;
  process.env.OIDC_UPSTREAM_CLIENT_ID = 'ldacapi';
  process.env.OIDC_UPSTREAM_CLIENT_SECRET = 'secret';

  // Imported after the environment is set, as configuration is read on import
  const { config } = await import('../configuration.ts');
  ({ prisma } = await import('../prisma.ts'));
  const { buildApp } = await import('../app.ts');
  const { Client } = await import('@opensearch-project/opensearch');
  const { createSearchBackend } = await import('../indexer/search.ts');
  app = buildApp({ repository, search: createSearchBackend(new Client({ node: config.opensearchUrl })) });
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
