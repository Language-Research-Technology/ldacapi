export const ACCESS_CONTROLS = ['Public', 'AuthorizationByApplication'] as const;

/** How Oni shows access is granted: at once, or by applying in REMS */
export type AccessControl = (typeof ACCESS_CONTROLS)[number];
