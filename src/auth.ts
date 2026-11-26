import { type IsAuthenticated, LicenceAccess, type RequestContext } from 'arocapi';
import type { FastifyRequest } from 'fastify';
import { createLocalJWKSet, errors, jwtVerify } from 'jose';
import { isOpenLicence } from './access/licences.ts';
import { config } from './configuration.ts';
import { publicJwks, SIGNING_ALG } from './oidc/keys.ts';

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

export const access = LicenceAccess({ hasLicence, ...(config.enrollmentUrl && { authorisationUrl: config.enrollmentUrl }) });

export const isAuthenticated: IsAuthenticated = async ({ request }) => Boolean(await authenticateUser(request));

async function hasLicence(licenseId: string, { request }: RequestContext): Promise<boolean> {
  if (isOpenLicence(licenseId)) {
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
  try {
    const res = await fetch(`${config.rems.endpoint}/entitlements?user=${encodeURIComponent(userId)}`, {
      headers: {
        'x-rems-api-key': config.rems.key,
        'x-rems-user-id': config.rems.user,
        accept: 'application/json',
      },
    });
    if (!res.ok) {
      throw new Error(`REMS responded ${res.status} ${res.statusText}`);
    }
    const data: RemsUserEntitlement[] = await res.json();
    return data.map((item) => item.resource);
  } catch (err) {
    request.log.error({ err }, 'Failed to fetch user entitlements');
    return;
  }
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

/** The cookie Oni sets so that downloads and media elements, which can't send a bearer token, carry one (ADR 0009) */
const TOKEN_COOKIE = 'oni_access_token';

/** Whether the request is for a file from one of Oni's own pages, or from a browser too old to say where it came from */
const acceptsTokenCookie = (request: FastifyRequest) =>
  request.routeOptions.url === `${config.prefix}/file/:id` && [undefined, 'same-origin'].includes(request.headers['sec-fetch-site']);

/** The token cookie's value, unless there is more than one, as when a sibling subdomain has planted its own */
const tokenCookie = (header = '') => {
  const [only, ...others] = header
    .split(';')
    .map((pair) => pair.trim())
    .filter((pair) => pair.startsWith(`${TOKEN_COOKIE}=`));
  if (only === undefined || others.length > 0) {
    return;
  }
  return only.slice(TOKEN_COOKIE.length + 1);
};

const presentedToken = (request: FastifyRequest) => {
  const header = request.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    return header.slice('Bearer '.length);
  }
  return acceptsTokenCookie(request) ? tokenCookie(request.headers.cookie) : undefined;
};

async function verifyUserId(request: FastifyRequest): Promise<string | undefined> {
  const { auth } = config;
  const token = presentedToken(request);
  if (!auth || !verificationKeys || !token) {
    return;
  }
  try {
    const { payload } = await jwtVerify(token, verificationKeys, {
      issuer: auth.issuer,
      audience: auth.audience,
      algorithms: [SIGNING_ALG],
      typ: 'at+jwt',
    });
    return payload.sub;
  } catch (error) {
    if (error instanceof errors.JOSEError) {
      return;
    }
    throw error;
  }
}
