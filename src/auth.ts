import type { AuthorisedEntity, AuthorisedFile, StandardEntity, StandardFile } from 'arocapi';
import type { FastifyRequest } from 'fastify';
import { config } from './configuration.ts';
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

// export async function resolveValidLicenses() {
//   return config.openLicenses;
// }

export async function accessTransformer(entity: StandardEntity, { request }: { request: FastifyRequest }): Promise<AuthorisedEntity> {
  const { metadataLicenseId, contentLicenseId } = entity;
  const canAccessMetadata = await checkLicense(request, metadataLicenseId);
  const canAccessContent = await checkLicense(request, contentLicenseId);
  if (!canAccessMetadata) {
    entity.description = '[Access is restricted]';
  }
  return {
    ...entity,
    access: {
      metadata: canAccessMetadata,
      content: canAccessContent,
      ...(!canAccessMetadata && { metadataAuthorizationUrl: enrollmentUrl(metadataLicenseId) }),
      ...(!canAccessContent && { contentAuthorizationUrl: enrollmentUrl(contentLicenseId) }),
    },
  };
}

export async function fileAccessTransformer(file: StandardFile, { request }: { request: FastifyRequest }): Promise<AuthorisedFile> {
  const entity = await prisma.entity.findUnique({ where: { id: file.id }, select: { contentLicenseId: true } });
  const contentLicenseId = entity?.contentLicenseId ?? '';
  const canAccessContent = await checkLicense(request, contentLicenseId);
  return {
    ...file,
    access: {
      content: canAccessContent,
      ...(!canAccessContent && { contentAuthorizationUrl: enrollmentUrl(contentLicenseId) }),
    },
  };
}

async function checkLicense(request: FastifyRequest, licenseId: string): Promise<boolean> {
  if (openLicenses.has(licenseId)) {
    return true;
  }
  let userLicenses = request.getDecorator<Promise<string[] | undefined> | null>('userLicenses');
  if (!userLicenses) {
    userLicenses = fetchUserLicenses(request);
    request.setDecorator('userLicenses', userLicenses);
  }
  return (await userLicenses)?.includes(licenseId) ?? false;
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

async function authenticateUser(request: FastifyRequest): Promise<string | undefined> {
  let userId = request.getDecorator<string>('userId');
  if (userId) {
    return userId;
  }
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
