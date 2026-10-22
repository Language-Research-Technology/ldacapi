import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../prisma.ts';
import { deleteExpired, PrismaAdapter } from './adapter.ts';

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('PrismaAdapter', () => {
  it('does not find expired entries', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const adapter = new PrismaAdapter('Session');
    await adapter.upsert('session-1', { uid: 'uid-1' }, 60);
    await adapter.upsert('session-2', { uid: 'uid-2' });

    vi.setSystemTime(Date.now() + 61_000);

    expect(await adapter.find('session-1')).toBeUndefined();
    expect(await adapter.findByUid('uid-1')).toBeUndefined();
    expect(await adapter.find('session-2')).toEqual({ uid: 'uid-2' });
  });

  it('treats an expiry of zero as already expired', async () => {
    const adapter = new PrismaAdapter('Session');
    await adapter.upsert('session-3', { uid: 'uid-3' }, 0);

    expect(await adapter.find('session-3')).toBeUndefined();
  });

  it('consumes an entry only once', async () => {
    const adapter = new PrismaAdapter('AuthorizationCode');
    await adapter.upsert('code-1', { grantId: 'grant-1' }, 60);
    await adapter.consume('code-1');

    await expect(adapter.consume('code-1')).rejects.toMatchObject({ error: 'invalid_grant' });
  });

  it('deletes expired entries', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const adapter = new PrismaAdapter('Grant');
    await adapter.upsert('grant-1', { accountId: 'user-1' }, 60);
    await adapter.upsert('grant-2', { accountId: 'user-1' }, 120);
    await adapter.upsert('grant-3', { accountId: 'user-1' });

    vi.setSystemTime(Date.now() + 61_000);
    await deleteExpired();

    const left = await prisma.oidcPayload.findMany({ where: { model: 'Grant', id: { in: ['grant-1', 'grant-2', 'grant-3'] } } });
    expect(left.map(({ id }) => id).sort()).toEqual(['grant-2', 'grant-3']);
  });
});
