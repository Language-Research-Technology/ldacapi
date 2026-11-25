import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildTestApp, type TestApp } from '../../test/app.ts';
import type * as adapter from './adapter.ts';

const HOUR_MS = 60 * 60 * 1000;
const logs = vi.hoisted(() => [] as { msg: string }[]);

vi.mock('../logger.ts', async () => (await import('../../test/logs.ts')).capturingLogger(logs, 'error'));
vi.mock('./adapter.ts', async (importOriginal) => {
  const original = await importOriginal<typeof adapter>();
  return { ...original, deleteExpired: vi.fn(original.deleteExpired) };
});

let app: TestApp;
let prisma: Awaited<ReturnType<typeof buildTestApp>>['prisma'];
let deleteExpired: typeof adapter.deleteExpired;

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  ({ app, prisma } = await buildTestApp({
    OIDC_ISSUER: 'http://localhost:8080',
    OIDC_CLIENTS: JSON.stringify([{ client_id: 'oni', redirect_uris: ['http://localhost:5173/callback'] }]),
    OIDC_UPSTREAM_ISSUER: 'https://idp.example.org',
    OIDC_UPSTREAM_CLIENT_ID: 'ldacapi',
    OIDC_UPSTREAM_CLIENT_SECRET: 'secret',
  }));
  await app.ready();
  ({ deleteExpired } = await import('./adapter.ts'));
});

afterAll(async () => {
  await app.close();
  vi.useRealTimers();
  await prisma.$disconnect();
});

describe('expired provider state', () => {
  it('is deleted every hour', async () => {
    const { PrismaAdapter } = await import('./adapter.ts');
    await new PrismaAdapter('Session').upsert('expired-session', {}, -1);

    vi.advanceTimersByTime(HOUR_MS);

    await vi.waitFor(async () => expect(await prisma.oidcPayload.findFirst({ where: { model: 'Session', id: 'expired-session' } })).toBeNull());
  });

  it('logs a failure to delete it', async () => {
    vi.mocked(deleteExpired).mockRejectedValueOnce(new Error('database is down'));

    vi.advanceTimersByTime(HOUR_MS);

    await vi.waitFor(() => expect(logs).toContainEqual(expect.objectContaining({ msg: "Can't delete expired OIDC provider state" })));
  });
});
