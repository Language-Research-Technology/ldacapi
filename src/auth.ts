import type { AuthorisedEntity, AuthorisedFile, StandardEntity } from 'arocapi';
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
function resolveEnrollmentUrl(licenseId: string) {
  return renderTemplate(licenseId);
}

export async function resolveValidLicenses() {
  return config.openLicenses;
}

export async function accessTransformer(
  entity: StandardEntity,
  { request }: { request: FastifyRequest },
): Promise<AuthorisedEntity | AuthorisedFile> {
  const { metadataLicenseId, contentLicenseId } = entity;
  const canAccessMetadata = await checkLicense(request, metadataLicenseId);
  const canAccessContent = await checkLicense(request, contentLicenseId);
  if (!canAccessMetadata) entity.description = '[Access is restricted]';
  return {
    ...entity,
    access: {
      metadata: canAccessMetadata,
      content: canAccessContent,
      metadataAuthorizationUrl: canAccessMetadata
        ? undefined
        : resolveEnrollmentUrl(encodeURIComponent(metadataLicenseId)),
      contentAuthorizationUrl: canAccessContent
        ? undefined
        : resolveEnrollmentUrl(encodeURIComponent(contentLicenseId)),
    },
  };
}

async function checkLicense(request: FastifyRequest, licenseId: string): Promise<boolean> {
  if (openLicenses.has(licenseId)) {
    return true;
  } else {
    let userLicenses = request.getDecorator<string[]>('userLicenses');
    if (!userLicenses) {
      const userId = await authenticateUser(request);
      if (userId && config.rems.endpoint) {
        const res = await fetch(`${config.rems.endpoint}/entitlements?user=${encodeURIComponent(userId)}`, {
          headers: {
            'x-rems-api-key': config.rems.key,
            'x-rems-user-id': config.rems.user,
            accept: 'application/json',
          },
        });
        console.log(res);
        if (res.ok) {
          const data = await res.json();
          console.log(data);
          userLicenses = data.map((item: RemsUserEntitlement) => item.resource);
          request.setDecorator('userLicenses', userLicenses);
        } else {
          request.log.error(`Failed to fetch user entitlements: ${res.status} ${res.statusText}`);
        }
      }
    }
    if (userLicenses) {
      return userLicenses.includes(licenseId);
    }
  }
  return false;
}

async function authenticateUser(request: FastifyRequest): Promise<string | undefined> {
  let userId = request.getDecorator<string>('userId');
  if (userId) return userId;
  if (config.oidc.userinfoEndpoint) {
    const authHeader = request.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      const res = await fetch(config.oidc.userinfoEndpoint, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      if (res.ok) {
        ({ sub: userId } = await res.json());
        if (userId) {
          request.setDecorator('userId', userId);
          return userId;
        }
      }
    }
  }
}
