import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { generateKeyPair, importJWK, type JWK, type JWTPayload, SignJWT } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Repository } from './repository.ts';

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

let app: ReturnType<typeof import('./app.ts').buildApp>;
let prisma: typeof import('./prisma.ts').prisma;
let signingKey: { key: CryptoKey | Uint8Array; kid: string };

// Stands in for both REMS (/entitlements) and the upstream provider (everything else)
let server: Server;
let received: IncomingMessage[] = [];

const repository = {
  storage: () => ({
    content: () => ({ type: 'stream', open: () => Readable.from(['content']), contentLength: 7, contentType: 'text/plain' }),
  }),
} as unknown as Repository;

const token = (claims: JWTPayload = {}, { key, kid } = signingKey) =>
  new SignJWT({ sub: ENTITLED, iss: ISSUER, aud: AUDIENCE, ...claims })
    .setProtectedHeader({ alg: 'RS256', kid })
    .setIssuedAt()
    .setExpirationTime(typeof claims.exp === 'number' ? claims.exp : '15m')
    .sign(key);

const get = (path: string, bearer?: string) => app.inject({ method: 'GET', url: `/api${path}`, headers: bearer ? { authorization: `Bearer ${bearer}` } : {} });

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

  process.env.OIDC_ISSUER = ISSUER;
  process.env.OIDC_UPSTREAM_ISSUER = fake;
  process.env.OIDC_UPSTREAM_CLIENT_ID = 'ldacapi';
  process.env.OIDC_UPSTREAM_CLIENT_SECRET = 'secret';
  process.env.REMS_ENDPOINT = fake;

  // Imported after the environment is set, as configuration is read on import
  const { config } = await import('./configuration.ts');
  ({ prisma } = await import('./prisma.ts'));
  const { buildApp } = await import('./app.ts');
  const { loadSigningKeys } = await import('./oidc/keys.ts');
  const { Client } = await import('@opensearch-project/opensearch');
  const { createSearchBackend } = await import('./indexer/search.ts');
  app = buildApp({ repository, search: createSearchBackend(new Client({ node: config.opensearchUrl })) });

  const [jwk] = (await loadSigningKeys(prisma)).keys as [JWK];
  signingKey = { key: await importJWK(jwk, 'RS256'), kid: jwk.kid as string };

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
