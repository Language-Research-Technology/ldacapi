import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../prisma.ts';
import { PrismaAdapter } from './adapter.ts';

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('PrismaAdapter', () => {
  it('finds what another instance stored', async () => {
    await new PrismaAdapter('Session').upsert('session-1', { uid: 'uid-1', accountId: 'user-1' }, 60);

    const adapter = new PrismaAdapter('Session');

    expect(await adapter.find('session-1')).toEqual({ uid: 'uid-1', accountId: 'user-1' });
    expect(await adapter.findByUid('uid-1')).toEqual({ uid: 'uid-1', accountId: 'user-1' });
    expect(await new PrismaAdapter('Grant').find('session-1')).toBeUndefined();
  });

  it('replaces an existing entry', async () => {
    const adapter = new PrismaAdapter('Grant');
    await adapter.upsert('grant-1', { accountId: 'user-1' }, 60);

    await adapter.upsert('grant-1', { accountId: 'user-2' }, 60);

    expect(await adapter.find('grant-1')).toEqual({ accountId: 'user-2' });
  });

  it('does not find expired entries', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const adapter = new PrismaAdapter('AuthorizationCode');
    await adapter.upsert('code-1', { grantId: 'grant-1' }, 60);
    await adapter.upsert('code-2', { grantId: 'grant-1' });

    vi.setSystemTime(Date.now() + 61_000);

    expect(await adapter.find('code-1')).toBeUndefined();
    expect(await adapter.find('code-2')).toEqual({ grantId: 'grant-1' });
  });

  it('does not find an expired session by uid', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    await new PrismaAdapter('Session').upsert('session-2', { uid: 'uid-2' }, 60);

    vi.setSystemTime(Date.now() + 61_000);

    expect(await new PrismaAdapter('Session').findByUid('uid-2')).toBeUndefined();
  });

  it('finds by user code', async () => {
    const adapter = new PrismaAdapter('DeviceCode');
    await adapter.upsert('device-1', { userCode: 'ABCD-EFGH' }, 60);

    expect(await adapter.findByUserCode('ABCD-EFGH')).toEqual({ userCode: 'ABCD-EFGH' });
  });

  it('marks an entry consumed', async () => {
    const adapter = new PrismaAdapter('AuthorizationCode');
    await adapter.upsert('code-3', { grantId: 'grant-2' }, 60);

    await adapter.consume('code-3');

    expect(await adapter.find('code-3')).toEqual({ grantId: 'grant-2', consumed: expect.any(Number) });
  });

  it('destroys an entry', async () => {
    const adapter = new PrismaAdapter('Interaction');
    await adapter.upsert('interaction-1', { uid: 'interaction-1' }, 60);

    await adapter.destroy('interaction-1');

    expect(await adapter.find('interaction-1')).toBeUndefined();
  });

  it('revokes by grant', async () => {
    const adapter = new PrismaAdapter('AccessToken');
    await adapter.upsert('at-1', { grantId: 'grant-3' }, 60);
    await adapter.upsert('at-2', { grantId: 'grant-4' }, 60);

    await adapter.revokeByGrantId('grant-3');

    expect(await adapter.find('at-1')).toBeUndefined();
    expect(await adapter.find('at-2')).toEqual({ grantId: 'grant-4' });
  });
});
