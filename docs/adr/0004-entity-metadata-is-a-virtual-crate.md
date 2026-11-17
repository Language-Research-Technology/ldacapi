# Each entity's metadata is a virtual crate built at index time

## Context

arocapi serves an entity's Metadata, its RO-Crate metadata document, at `/entity/:id/metadata`, through the Metadata half of the storage backend, after checking the entity's metadata licence. A crate's `ro-crate-metadata.json` describes many entities, each with its own licences, and a large collection's runs to many megabytes. Oni asks for the metadata of the entity it is showing, not of the whole crate.

Crates in the repository spell LDaC and PCDM properties two ways: through the context (`communicationMode`, `hasMember`) or with a prefix (`ldac:communicationMode`, `pcdm:hasMember`). Oni reads the prefixed forms. Some crates also describe files the repository doesn't hold.

## Decision

Each entity's Metadata is a virtual crate: a new RO-Crate with the entity as its root, plus every entity it links to, directly or through others. The indexer builds it when it indexes the crate and stores it in the entity's row as `meta.rocrate`, and arocapi's `EntityMetaMetadata` serves it from there. Nothing serves a crate's `ro-crate-metadata.json` as it is, and the crate in the repository is never changed.

The virtual crate differs from what the depositor wrote in these ways only:

- The root gets the `Dataset` type, the crate root's `conformsTo` if it has none, and the crate's content licence as its `license` if it has none.
- On the root and every entity it links to, a property whose term resolves to an LDaC terms IRI is named `ldac:<name>`, and one that resolves to a PCDM IRI is named `pcdm:<name>`. Where an entity has both spellings, their values are merged.
- A bare `memberOf` on a Collection, Object or File is named `pcdm:memberOf`. The RO-Crate context maps bare `memberOf` to schema.org's, so on a Person or Organisation it is left as it is.
- The `ldac` and `pcdm` prefixes are added to the depositor's `@context` if it lacks them.
- A File entity whose content the repository doesn't hold gets `display: false`, which Oni reads to offer no preview or download.

## Consequences

- A request for one entity's Metadata gets only that entity and what it links to, guarded by that entity's metadata licence, rather than every entity in its crate.
- Oni and other readers see one spelling of LDaC and PCDM properties, whichever the crate used.
- Metadata is only as fresh as the last index run: importing a new version of a crate changes nothing that is served until the crate is reindexed.
- Serving Metadata reads only the database, never the OCFL repository.
- The virtual crate isn't a file in the crate, so it has no checksum or version of its own, and it is not a faithful copy of what the depositor wrote. The deposited crate is only in the repository.
- `display` is Oni's convention, not a vocabulary term; a different reader won't know it.
- Other vocabularies, values and `@type`s are served as deposited, including any mistakes in them.
- Rows are larger, as each holds a copy of what its entity links to.
