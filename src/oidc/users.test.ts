import type { KoaContextWithOIDC } from 'oidc-provider';
import { afterAll, expect, it } from 'vitest';
import { prisma } from '../prisma.ts';
import { findAccount } from './users.ts';

afterAll(async () => {
  await prisma.$disconnect();
});

it('finds no account for a subject that has never signed in', async () => {
  expect(await findAccount({} as KoaContextWithOIDC, 'never-signed-in')).toBeUndefined();
});
