import type { Account, KoaContextWithOIDC } from 'oidc-provider';
import type { IDToken } from 'openid-client';
import { prisma } from '../prisma.ts';

export const findAccount = async (_ctx: KoaContextWithOIDC, sub: string): Promise<Account | undefined> => {
  const user = await prisma.user.findUnique({ where: { sub } });
  if (!user) {
    return undefined;
  }
  return {
    accountId: sub,
    claims: () => ({
      sub,
      name: user.name ?? undefined,
      email: user.email ?? undefined,
      given_name: user.givenName ?? undefined,
      family_name: user.familyName ?? undefined,
    }),
  };
};

const stringOrNull = (value: unknown) => (typeof value === 'string' ? value : null);

/** Stores the user's latest details from the upstream provider's ID token */
export const saveUser = ({ sub, ...claims }: IDToken) => {
  const details = {
    name: stringOrNull(claims.name),
    email: stringOrNull(claims.email),
    givenName: stringOrNull(claims.given_name),
    familyName: stringOrNull(claims.family_name),
  };
  return prisma.user.upsert({ where: { sub }, create: { sub, ...details }, update: details });
};
