import { type IsAuthenticated, LicenceAccess, type RequestContext } from 'arocapi';
import type { FastifyRequest } from 'fastify';
import { config } from './configuration.ts';

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
  console.log(res);
  if (!res.ok) {
    request.log.error(`Failed to fetch user entitlements: ${res.status} ${res.statusText}`);
    return;
  }
  const data = await res.json();
  console.log(data);
  return data.map((item: RemsUserEntitlement) => item.resource);
}

const userIdsByRequest = new WeakMap<FastifyRequest, Promise<string | undefined>>();
function authenticateUser(request: FastifyRequest): Promise<string | undefined> {
  let userId = userIdsByRequest.get(request);
  if (!userId) {
    userId = fetchUserId(request);
    userIdsByRequest.set(request, userId);
  }
  return userId;
}

async function fetchUserId(request: FastifyRequest): Promise<string | undefined> {
  const authHeader = request.headers.authorization;
  if (!config.oidc.userinfoEndpoint || !authHeader?.startsWith('Bearer ')) {
    return;
  }
  const token = authHeader.split(' ')[1];
  const res = await fetch(config.oidc.userinfoEndpoint, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  if (res.ok) {
    const { sub } = await res.json();
    return sub || undefined;
  }
}
