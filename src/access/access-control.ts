import { isOpenLicence } from './licences.ts';

export const ACCESS_CONTROLS = ['Public', 'AuthorizationByApplication'] as const;

/** How Oni shows access is granted: at once, or by applying in REMS */
export type AccessControl = (typeof ACCESS_CONTROLS)[number];

/** Open licences need nothing; every other LDaCA licence is granted by application in REMS */
export const accessControlFor = (contentLicenseId: string): AccessControl => (isOpenLicence(contentLicenseId) ? 'Public' : 'AuthorizationByApplication');
