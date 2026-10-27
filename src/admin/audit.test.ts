import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { ALICE, adminTestbed, PEOPLE, repositoryIn } from '../../test/admin.ts';

const logs = vi.hoisted(() => [] as Record<string, unknown>[]);

vi.mock('../logger.ts', async () => {
  const { pino } = await import('pino');
  const stream = new Writable({
    write(chunk, _encoding, done) {
      logs.push(JSON.parse(chunk.toString()));
      done();
    },
  });
  return { logger: pino({ level: 'info' }, stream) };
});

const testbed = adminTestbed();

describe('the audit log', () => {
  it('records each accepted and refused action, with who asked', async () => {
    const { app } = await testbed.start({ ADMIN_USERS: ALICE.sub }, { repository: repositoryIn('indexed') });
    const { browser } = await testbed.signInAsAdmin(app, ALICE);

    await browser.post('/admin/index', { crateId: PEOPLE, force: 'true' });
    await browser.post('/admin/delete', {});
    await browser.post('/admin/index', { crateId: PEOPLE });

    expect(logs.filter(({ action }) => action)).toEqual([
      expect.objectContaining({ level: 30, sub: ALICE.sub, action: 'index', crateId: PEOPLE, force: true, accepted: true }),
      expect.objectContaining({ level: 30, sub: ALICE.sub, action: 'delete', crateId: 'all', force: false, accepted: true }),
      expect.objectContaining({ level: 30, sub: ALICE.sub, action: 'index', crateId: PEOPLE, force: false, accepted: false }),
    ]);
  });
});
