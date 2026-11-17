import { ACCESS_CONTROLS, type AccessControl } from './access/access-control.ts';

/** What the database index keeps in `Entity.meta` */
export type EntityMeta = { rocrate: unknown; accessControl: AccessControl };

export const accessControlOf = (meta: unknown): AccessControl | undefined => {
  const value = (meta as Partial<EntityMeta> | null)?.accessControl;
  return ACCESS_CONTROLS.find((accessControl) => accessControl === value);
};
