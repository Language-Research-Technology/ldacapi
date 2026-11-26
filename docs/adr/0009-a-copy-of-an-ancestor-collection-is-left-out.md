# A crate's copy of a collection above it is left out

## Context

A collection, object or file belongs to one crate, and a second crate describing it fails its index job (ADR 0006).

Crates often describe the collections above them as well as linking to them: a language crate holds a full, profiled copy of its top collection beside its `pcdm:memberOf` link to its family collection. Each such crate claims the top collection, so all but the first one indexed fail, and the winner may be a child whose copy differs from the top crate's own description.

Indexing finds a crate's parent crates by following `pcdm:memberOf` up through the repository, so it knows which collections are above a crate however many crates are indexed yet.

## Decision

An entity whose id is one of the crate's parent crates is left out of the crate's derivation, whatever type the copy gives it: it has no row, no crate link and no search document from that crate, adds nothing to aggregates, and lends no licence to the crate's records. When the copy is a record, the job logs a warning naming it (its id is also its own crate's id) and the type the copy gave it, and still succeeds. That collection's own crate is the only one that holds it.

Every other clash still fails the job: a collection, object or file held by a crate not above it, or an id described as a different kind of entity.

## Consequences

- Indexing gives the same rows whatever order crates are indexed in, and a collection's row is always its own crate's description.
- A copy that adds to the collection (such as extra `hasPart` links) is ignored; only the collection's own crate can change it.
- Links in the copy still count as links: a `pcdm:hasMember` in it can still make a record of the crate its member, as it is how the crate's own parent crates are found.
- A linked record in a child's virtual crate is still a stub, as the copy is still a record, just one the child doesn't hold.
- When a parent crate can't be read, the parent crates stop below it, so a copy of a collection above that point still clashes.
