# Each entity's metadata is a virtual crate built at index time

## Context

arocapi serves an entity's Metadata, its RO-Crate metadata document, at `/entity/:id/metadata`, through the Metadata half of the storage backend, after checking the entity's metadata licence. A crate's `ro-crate-metadata.json` describes many entities, each with its own licences, and a large collection's runs to many megabytes. Oni asks for the metadata of the entity it is showing, not of the whole crate.

The LDaC profile spells LDaC and PCDM properties with a prefix (`ldac:communicationMode`, `pcdm:memberOf`), and Oni reads those forms. Older crates spelt them through the context instead (`communicationMode`, `memberOf`). Some crates also describe files the repository doesn't hold.

## Decision

Each entity's Metadata is a virtual crate: a new RO-Crate with the entity as its root, plus every entity it links to, directly or through others. The indexer builds it when it indexes the crate and stores it in the entity's row as `meta.rocrate`, and arocapi's `EntityMetaMetadata` serves it from there. Nothing serves a crate's `ro-crate-metadata.json` as it is, and the crate in the repository is never changed.

The virtual crate differs from what the depositor wrote in these ways only:

- The root gets the `Dataset` type, the crate root's `conformsTo` if it has none, and the crate's content licence as its `license` if it has none.
- A File entity whose content the repository doesn't hold gets `display: false`, which Oni reads to offer no preview or download.

Property names are served as deposited. Crates are assumed to use the prefixed spelling: the indexer reads LDaC and PCDM properties only in that form, and the virtual crate does not rename the older one. Bringing an older crate up to date is its owner's job.

## Consequences

- A request for one entity's Metadata gets only that entity and what it links to, guarded by that entity's metadata licence, rather than every entity in its crate.
- A crate that still uses the older spelling is indexed without those properties: its entities have no parent from a bare `memberOf` or `hasMember`, are missing from the matching search facets, and Oni doesn't show the values.
- Metadata is only as fresh as the last index run: importing a new version of a crate changes nothing that is served until the crate is reindexed.
- Serving Metadata reads only the database, never the OCFL repository.
- The virtual crate isn't a file in the crate, so it has no checksum or version of its own, and it is not a faithful copy of what the depositor wrote. The deposited crate is only in the repository.
- `display` is Oni's convention, not a vocabulary term; a different reader won't know it.
- Property names, values and `@type`s are served as deposited, including any mistakes in them.
- Rows are larger, as each holds a copy of what its entity links to.
