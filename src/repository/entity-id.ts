const ABSOLUTE_IRI = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** Whether `id` is an absolute IRI: a scheme followed by `:` */
export const isAbsoluteIri = (id: string) => ABSOLUTE_IRI.test(id);

/**
 * The id an entity is indexed under: an absolute IRI as it is, so one in two crates is one entity;
 * a relative or blank-node id under the crate root's
 */
export const entityId = (crateRootId: string, id: string) => (isAbsoluteIri(id) ? id : `${crateRootId}/${id}`);
