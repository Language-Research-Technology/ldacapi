# Each entity's metadata is a virtual crate built at index time

## Context

arocapi serves an entity's Metadata, its RO-Crate metadata document, at `/entity/:id/metadata`, through the Metadata half of the storage backend, after checking the entity's metadata licence. A crate's `ro-crate-metadata.json` describes many entities, each with its own licences, and a large collection's runs to many megabytes. Oni asks for the metadata of the entity it is showing, not of the whole crate.

## Decision

Each entity's Metadata is a virtual crate: a new RO-Crate with the entity as its root, plus every entity it links to, directly or through others. The root also gets the `Dataset` type, the crate root's `conformsTo` if it has none, and the crate's content licence as its `license` if it has none. The database indexer builds it when it indexes the crate and stores it in the entity's row as `meta.rocrate`, and arocapi's `EntityMetaMetadata` serves it from there. Nothing serves a crate's `ro-crate-metadata.json` as it is.

## Consequences

- A request for one entity's Metadata gets only that entity and what it links to, guarded by that entity's metadata licence, rather than every entity in its crate.
- Metadata is only as fresh as the last index run: importing a new version of a crate changes nothing that is served until the crate is reindexed.
- Serving Metadata reads only the database, never the OCFL repository.
- The virtual crate isn't a file in the crate, so it has no checksum or version of its own, and it differs from what the depositor wrote by the properties added to its root.
- Rows are larger, as each holds a copy of what its entity links to.
