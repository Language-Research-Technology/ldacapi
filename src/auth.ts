import { type IsAuthenticated, LicenceAccess, type RequestContext } from 'arocapi';
import type { FastifyRequest } from 'fastify';
import { createLocalJWKSet, errors, jwtVerify } from 'jose';
import { config } from './configuration.ts';
import { loadSigningKeys } from './oidc/keys.ts';
import { prisma } from './prisma.ts';

const openLicenses = new Set(config.openLicenses);

type RemsUserEntitlement = {
  resource: string;
  user: {
    userid: string;
    name: string;
    email: string;
  };
  'application-id': string;
  start: string;
  end: string;
  mail: string;
};

const renderTemplate = new Function('licenseId', `return \`${config.enrollmentUrl}\`;`);
function enrollmentUrl(licenseId: string): string {
  return renderTemplate(encodeURIComponent(licenseId));
}

export const access = LicenceAccess({ hasLicence, authorisationUrl: enrollmentUrl });

export const isAuthenticated: IsAuthenticated = async ({ request }) => Boolean(await authenticateUser(request));

async function hasLicence(licenseId: string, { request }: RequestContext): Promise<boolean> {
  if (openLicenses.has(licenseId)) {
    return true;
  }
  return (await userLicenses(request))?.includes(licenseId) ?? false;
}

const userLicensesByRequest = new WeakMap<FastifyRequest, Promise<string[] | undefined>>();
function userLicenses(request: FastifyRequest): Promise<string[] | undefined> {
  let licenses = userLicensesByRequest.get(request);
  if (!licenses) {
    licenses = fetchUserLicenses(request);
    userLicensesByRequest.set(request, licenses);
  }
  return licenses;
}

async function fetchUserLicenses(request: FastifyRequest): Promise<string[] | undefined> {
  const userId = await authenticateUser(request);
  if (!userId || !config.rems.endpoint) {
    return;
  }
  const res = await fetch(`${config.rems.endpoint}/entitlements?user=${encodeURIComponent(userId)}`, {
    headers: {
      'x-rems-api-key': config.rems.key,
      'x-rems-user-id': config.rems.user,
      accept: 'application/json',
    },
  });
  if (!res.ok) {
    request.log.error({ status: res.status, statusText: res.statusText }, 'Failed to fetch user entitlements');
    return;
  }
  const data = await res.json();
  return data.map((item: RemsUserEntitlement) => item.resource);
}

const userIdsByRequest = new WeakMap<FastifyRequest, Promise<string | undefined>>();
function authenticateUser(request: FastifyRequest): Promise<string | undefined> {
  let userId = userIdsByRequest.get(request);
  if (!userId) {
    userId = verifyUserId(request);
    userIdsByRequest.set(request, userId);
  }
  return userId;
}

const publicKeys = async () => {
  const { keys } = await loadSigningKeys(prisma);
  return createLocalJWKSet({ keys: keys.map(({ d, p, q, dp, dq, qi, ...publicJwk }) => publicJwk) });
};

let verificationKeys: ReturnType<typeof publicKeys> | undefined;

async function verifyUserId(request: FastifyRequest): Promise<string | undefined> {
  const authHeader = request.headers.authorization;
  if (!config.auth.enabled || !authHeader?.startsWith('Bearer ')) {
    return;
  }
  verificationKeys ??= publicKeys().catch((error) => {
    verificationKeys = undefined;
    throw error;
  });
  try {
    const { payload } = await jwtVerify(authHeader.slice('Bearer '.length), await verificationKeys, {
      issuer: config.auth.issuer,
      audience: config.auth.audience,
      algorithms: ['RS256'],
    });
    return payload.sub || undefined;
  } catch (error) {
    if (error instanceof errors.JOSEError) {
      return;
    }
    throw error;
  }
}
