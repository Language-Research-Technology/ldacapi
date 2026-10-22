import { type IsAuthenticated, LicenceAccess, type RequestContext } from 'arocapi';
import type { FastifyRequest } from 'fastify';
import { createLocalJWKSet, errors, jwtVerify } from 'jose';
import { config } from './configuration.ts';
import { publicJwks, SIGNING_ALG } from './oidc/keys.ts';

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

const verificationKeys = config.auth && createLocalJWKSet(publicJwks(config.auth.signingKeys));

async function verifyUserId(request: FastifyRequest): Promise<string | undefined> {
  const { auth } = config;
  const authHeader = request.headers.authorization;
  if (!auth || !verificationKeys || !authHeader?.startsWith('Bearer ')) {
    return;
  }
  try {
    const { payload } = await jwtVerify(authHeader.slice('Bearer '.length), verificationKeys, {
      issuer: auth.issuer,
      audience: auth.audience,
      algorithms: [SIGNING_ALG],
      typ: 'at+jwt',
    });
    return payload.sub || undefined;
  } catch (error) {
    if (error instanceof errors.JOSEError) {
      return;
    }
    throw error;
  }
}
