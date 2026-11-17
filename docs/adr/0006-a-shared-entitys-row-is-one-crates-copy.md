# A shared entity's row is one crate's copy

## Context

An entity's id is its primary key in arocapi's `Entity` model, and an absolute IRI is kept as the id, so the same person, organisation or software entity (an ORCID, a ROR, a repository URL) described by several crates is one row. The row's columns hold one value each: name, description, the two licences and the virtual crate. Crates can disagree on all of them, and the metadata licence comes from the crate, not the entity.

A collection, object or file is different: it is described by one crate. The same id in a second crate is a fault in the data.

arocapi's queries can't join to our tables, and its models have no column for the crates an entity came from.

## Decision

**Crate links.** A link table in our own models records each (crate, entity) pair, indexed both ways. It is the only record of which crates contain an entity; `Entity.meta` has no `crateId`. Indexing a crate writes its links; deleting a crate removes its links, then removes the entities left with none.

**Collections, objects and files have one crate.** When a crate describes one that another crate already holds, or describes an id as a different kind of entity than the row has, that entity is refused: the holder keeps the row, the rest of the crate is indexed, and the clash is reported once per crate as an error naming both crates.

**Shared entities have one winning copy.** For a person, organisation or software entity, each link keeps that crate's derived copy. The row and the search document are wholly the copy of one crate: a crate whose metadata licence is open before one whose licence isn't, then the lowest crate id. Copies are never merged. When the winning crate is deleted or stops containing the entity, the row and document are rebuilt from the next crate's stored copy, without reading the repository.

**Shared entities have no root collection.** `rootCollection` is null on every person, organisation and software row, whether or not a second crate contains it.

Rejected: a reference count (can't say which crates, drifts when a run dies, no lookup by crate); a `roCrateIds` array in `meta` (unindexed, so every lookup by crate scans); last indexed wins (the repository walk is unordered, so a rebuild could change a row's licences); merging copies (no sound merge of two licences, and a virtual crate matching no deposited crate); the winning crate's root collection (a person in four collections would be found under one).

## Consequences

- Deleting or reindexing one crate leaves entities that other crates contain, and is database work only.
- A full rebuild gives the same shared rows whatever order crates are indexed in. Which crate holds a clashing collection, object or file does depend on order; the error is reported on every run until the data is fixed.
- What a request reads of a shared entity is one crate's description under that crate's licence, so nothing from a restricted crate shows through an open copy. A restricted copy wins only when no open one exists.
- The winner depends on the configured open licences, so changing them needs a reindex, as it already does for access control.
- A shared entity counts in each crate that contains it, so per-crate counts sum to more than the number of rows.
- A crate that mentions a person without the LDaC profile has no link to them.
- Shared entities are in no bucket of the Collection facet, and Oni shows no collection breadcrumb or "Member of" card on organisation and software pages.
- If the deposit API needs `roCrateIds`, it is read from the links.
