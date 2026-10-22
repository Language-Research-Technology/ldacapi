import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateKeyPair, importJWK, type JWTPayload, SignJWT } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, repositoryWithContent, type TestApp } from '../test/app.ts';
import { generateSigningKey, type Jwk } from './oidc/keys.ts';

const ISSUER = 'http://localhost:8080';
const AUDIENCE = `${ISSUER}/api`;
const OPEN = 'https://creativecommons.org/licenses/by/4.0/';
const RESTRICTED = 'https://example.org/licenses/restricted';
const RESTRICTED_METADATA = 'https://example.org/licenses/restricted-metadata';
const ENTITLED = 'upstream-user-entitled';
const UNENTITLED = 'upstream-user-unentitled';

const OPEN_FILE = 'http://test/licence/open.txt';
const RESTRICTED_FILE = 'http://test/licence/restricted.txt';
const RESTRICTED_ENTITY = 'http://test/licence/restricted';

let app: TestApp;
let prisma: Awaited<ReturnType<typeof buildTestApp>>['prisma'];
let prefix: string;
// Signs with the first; the second is the previous key, kept so its tokens still verify
const SIGNING_KEYS = [generateSigningKey(), generateSigningKey()];

type SigningKey = { key: CryptoKey | Uint8Array; kid: string };
const importSigningKey = async (jwk: Jwk): Promise<SigningKey> => ({ key: await importJWK(jwk, 'RS256'), kid: jwk.kid });
let signingKey: SigningKey;

// Stands in for both REMS (/entitlements) and the upstream provider (everything else)
let server: Server;
let received: IncomingMessage[] = [];

const token = (claims: JWTPayload = {}, { key, kid } = signingKey, typ = 'at+jwt') =>
  new SignJWT({ sub: ENTITLED, iss: ISSUER, aud: AUDIENCE, ...claims })
    .setProtectedHeader({ alg: 'RS256', kid, typ })
    .setIssuedAt()
    .setExpirationTime(typeof claims.exp === 'number' ? claims.exp : '15m')
    .sign(key);

const get = (path: string, bearer?: string) =>
  app.inject({ method: 'GET', url: `${prefix}${path}`, headers: bearer ? { authorization: `Bearer ${bearer}` } : {} });

const file = (id: string, bearer?: string) => get(`/file/${encodeURIComponent(id)}`, bearer);

const remsRequests = () => received.filter(({ url }) => url?.startsWith('/entitlements'));

const createEntity = (id: string, metadataLicenseId: string, contentLicenseId: string) =>
  prisma.entity.create({
    data: { id, name: id, description: '', entityType: 'http://schema.org/MediaObject', metadataLicenseId, contentLicenseId },
  });

const createFile = async (id: string, contentLicenseId: string) => {
  await createEntity(id, OPEN, contentLicenseId);
  await prisma.file.create({ data: { id, filename: 'file.txt', mediaType: 'text/plain', size: 7 } });
};

beforeAll(async () => {
  server = createServer((request, response) => {
    received.push(request);
    const user = new URL(request.url ?? '', 'http://rems').searchParams.get('user');
    const entitlements = user === ENTITLED ? [{ resource: RESTRICTED }, { resource: RESTRICTED_METADATA }] : [];
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(entitlements));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const fake = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  let config: Awaited<ReturnType<typeof buildTestApp>>['config'];
  ({ app, prisma, config } = await buildTestApp(
    {
      OIDC_ISSUER: ISSUER,
      OIDC_CLIENTS: JSON.stringify([{ client_id: 'oni', redirect_uris: ['http://localhost:5173/callback'] }]),
      OIDC_UPSTREAM_ISSUER: fake,
      OIDC_UPSTREAM_CLIENT_ID: 'ldacapi',
      OIDC_UPSTREAM_CLIENT_SECRET: 'secret',
      REMS_ENDPOINT: fake,
      OIDC_SIGNING_KEYS: JSON.stringify({ keys: SIGNING_KEYS }),
    },
    { repository: repositoryWithContent },
  ));
  ({ prefix } = config);

  signingKey = await importSigningKey(SIGNING_KEYS[0] as Jwk);

  await createFile(OPEN_FILE, OPEN);
  await createFile(RESTRICTED_FILE, RESTRICTED);
  await createEntity(RESTRICTED_ENTITY, RESTRICTED_METADATA, RESTRICTED);
});

beforeEach(() => {
  received = [];
});

afterAll(async () => {
  await prisma.file.deleteMany({ where: { id: { in: [OPEN_FILE, RESTRICTED_FILE] } } });
  await prisma.entity.deleteMany({ where: { id: { in: [OPEN_FILE, RESTRICTED_FILE, RESTRICTED_ENTITY] } } });
  await app.close();
  await prisma.$disconnect();
  await new Promise((resolve) => server.close(resolve));
});

describe('licence checks with our access tokens', () => {
  it('gives content under a restricted licence to a user REMS entitles', async () => {
    const response = await file(RESTRICTED_FILE, await token());

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('content');
    expect(remsRequests().map(({ url }) => url)).toEqual([`/entitlements?user=${ENTITLED}`]);
  });

  it('accepts a token signed with the previous signing key', async () => {
    const response = await file(RESTRICTED_FILE, await token({}, await importSigningKey(SIGNING_KEYS[1] as Jwk)));

    expect(response.statusCode).toBe(200);
  });

  it('refuses restricted content to a signed-in user without the entitlement', async () => {
    const response = await file(RESTRICTED_FILE, await token({ sub: UNENTITLED }));

    expect(response.statusCode).toBe(403);
  });

  it('asks REMS once per request, however many licences it checks', async () => {
    const response = await get(`/entity/${encodeURIComponent(RESTRICTED_ENTITY)}`, await token());

    expect(response.json().access).toMatchObject({ metadata: true, content: true });
    expect(remsRequests()).toHaveLength(1);
  });

  it('does not call the upstream provider', async () => {
    await file(RESTRICTED_FILE, await token());

    expect(received.filter((request) => !remsRequests().includes(request))).toEqual([]);
  });

  const anonymousTokens: [string, () => Promise<string | undefined>][] = [
    ['no token', async () => undefined],
    ['a malformed token', async () => 'not-a-jwt'],
    ['an expired token', () => token({ exp: Math.floor(Date.now() / 1000) - 60 })],
    [
      'a token signed with another key',
      async () => {
        const { privateKey } = await generateKeyPair('RS256');
        return token({}, { key: privateKey, kid: signingKey.kid });
      },
    ],
    ['a token from another issuer', () => token({ iss: 'https://idp.example.org' })],
    ['a token for another audience', () => token({ aud: 'https://other.example.org/api' })],
    ['a token that is not an access token', () => token({}, signingKey, 'JWT')],
  ];

  describe.each(anonymousTokens)('with %s', (_name, bearer) => {
    it('still serves content under an open licence', async () => {
      const response = await file(OPEN_FILE, await bearer());

      expect(response.statusCode).toBe(200);
    });

    it('asks for authentication for content under a restricted licence', async () => {
      const response = await file(RESTRICTED_FILE, await bearer());

      expect(response.statusCode).toBe(401);
      expect(remsRequests()).toEqual([]);
    });
  });
});
