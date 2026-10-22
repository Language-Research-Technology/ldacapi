import { calculateJwkThumbprint, exportJWK, generateKeyPair, type JWK } from 'jose';
import type { PrismaClient } from '../generated/prisma/client.ts';

// Arbitrary constant identifying the key-generation advisory lock
const LOCK = 0x01dc_0001;

const generateSigningKey = async (): Promise<JWK> => {
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = await exportJWK(privateKey);
  return { ...jwk, kid: await calculateJwkThumbprint(jwk), alg: 'RS256', use: 'sig' };
};

/** The private JWKS the provider signs with, generated and stored on first call */
export const loadSigningKeys = (prisma: PrismaClient): Promise<{ keys: JWK[] }> =>
  prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK})`;
    let rows = await tx.oidcSigningKey.findMany({ orderBy: { createdAt: 'asc' } });
    if (rows.length === 0) {
      const jwk = await generateSigningKey();
      rows = [await tx.oidcSigningKey.create({ data: { kid: jwk.kid as string, jwk: jwk as object } })];
    }
    return { keys: rows.map((row) => row.jwk as JWK) };
  });
