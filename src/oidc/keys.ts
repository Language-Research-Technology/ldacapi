import { createHash, createPublicKey, generateKeyPairSync, type JsonWebKey, randomBytes } from 'node:crypto';

/** The algorithm our tokens are signed with */
export const SIGNING_ALG = 'RS256';

export type Jwk = JsonWebKey & { kid: string };

// RFC 7638: the required members in lexicographic order
const thumbprint = ({ e, kty, n }: JsonWebKey) => createHash('sha256').update(JSON.stringify({ e, kty, n })).digest('base64url');

/** A private RSA JWK for signing our tokens */
export const generateSigningKey = (): Jwk => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = privateKey.export({ format: 'jwk' });
  return { ...jwk, kid: thumbprint(jwk), alg: SIGNING_ALG, use: 'sig' };
};

/** A secret for signing the provider's cookies */
export const generateCookieKey = () => randomBytes(32).toString('base64url');

/** The public JWKS that verifies tokens signed with `keys` */
export const publicJwks = (keys: Jwk[]) => ({
  keys: keys.map((jwk) => ({ ...createPublicKey({ key: jwk, format: 'jwk' }).export({ format: 'jwk' }), kid: jwk.kid, alg: SIGNING_ALG, use: 'sig' })),
});
