# LDaCA API

Serves RO-Crates from OCFL storage through the arocapi API, and controls access to them by licence.

## Language

arocapi's terms, such as **Record**, **Metadata**, **Content** and **Row**, mean what [arocapi's glossary](https://github.com/crate-works/arocapi/blob/main/GLOSSARY.md) says.

### Crates and indexes

**Crate**:
One RO-Crate, stored as one OCFL object in the repository. The unit of import, indexing and admin actions.
_Avoid_: OCFL object (the storage), collection (what a crate may describe)

**Import**:
Bringing RO-Crates into the OCFL repository: `pnpm crates:import` today, the deposit API in future.
_Avoid_: Seed

**Index**:
Building the database index and the search index from the repository, for one crate or all of them. Both can be deleted and rebuilt at any time.
_Avoid_: Import

**Database index**:
The Entity and File rows that arocapi reads, written by the indexer (arocapi's Rows).
_Avoid_: Structural index

**Search index**:
The search documents in arocapi's search backend, one per entity that has a row.
_Avoid_: OpenSearch index (one backend's storage)

### Authentication

**Upstream provider**:
The one external identity provider, set by configuration, that users sign in at.
_Avoid_: IdP, CILogon (one instance of it), login provider

**User**:
A person who has signed in at the upstream provider, identified by that provider's subject identifier. REMS knows the same person by the same identifier.
_Avoid_: Account, member

### Access

**Visibility**:
Whether an entity exists for a request at all. Every entity is visible to everyone (ADR 0003).
_Avoid_: Access

**Access**:
What a request may read of a visible entity, decided by its metadata and content licences.
_Avoid_: Visibility, permissions

**Access control**:
How Oni tells users they can get an entity's content: `Public` when its content licence is open, otherwise `AuthorizationByApplication` (apply in REMS). The indexer decides it and stores it with the entity; it describes the licence, not what a particular request may read.
_Avoid_: Access, access level

### Admin

**Admin**:
A user who can use the admin pages, currently one whose `sub` is in `ADMIN_USERS`.
_Avoid_: Administrator, superuser, staff

**Admin pages**:
The server-rendered admin UI at `/admin/` on the admin origin (`ADMIN_ORIGIN`).
_Avoid_: Portal, admin API
