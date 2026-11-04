import { isOpenLicence } from './licences.ts';

const ACCESS_CONTROLS = ['Public', 'AuthorizationByApplication'] as const;

/** How Oni shows access is granted: at once, or by applying in REMS */
export type AccessControl = (typeof ACCESS_CONTROLS)[number];

/** What the database index keeps in `Entity.meta`; `crateId` is the crate the entity was indexed from */
export type EntityMeta = { crateId: string; rocrate: unknown; accessControl: AccessControl };

export const accessControlOf = (meta: unknown): AccessControl | undefined => {
  const value = (meta as Partial<EntityMeta> | null)?.accessControl;
  return ACCESS_CONTROLS.find((accessControl) => accessControl === value);
};

/** Open licences need nothing; every other LDaCA licence is granted by application in REMS */
export const accessControlFor = (contentLicenseId: string): AccessControl => (isOpenLicence(contentLicenseId) ? 'Public' : 'AuthorizationByApplication');
