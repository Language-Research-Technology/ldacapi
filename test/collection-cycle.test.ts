import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ocflTestbed } from './app.ts';
import { collection, crate } from './crate-builder.ts';

const logs = vi.hoisted(() => [] as Record<string, unknown>[]);

vi.mock('../src/logger.ts', async () => (await import('./logs.ts')).capturingLogger(logs, 'warn'));

const FIRST = 'arcp://name,cycle_first';
const SECOND = 'arcp://name,cycle_second';
const testbed = ocflTestbed(crate(collection(FIRST, { memberOf: SECOND })), crate(collection(SECOND, { memberOf: FIRST })));

beforeAll(async () => {
  await testbed.started.repository.deleteIndex();
  await testbed.started.repository.createIndex(FIRST);
});

describe('collections that are members of each other', () => {
  it('logs the cycle, naming the crates', () => {
    expect(logs).toContainEqual(
      expect.objectContaining({
        level: 40,
        crateId: FIRST,
        cycle: [FIRST, SECOND, FIRST],
        msg: 'Collections are members of each other; using the highest found',
      }),
    );
  });

  it('still indexes the crate under the highest collection found', async () => {
    const row = await testbed.started.prisma.entity.findUnique({ where: { id: FIRST }, select: { rootCollection: true } });

    expect(row?.rootCollection).toBe(SECOND);
  });
});
