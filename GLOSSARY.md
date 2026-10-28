# LDaCA API

Serves RO-Crates from OCFL storage through the arocapi API, and controls access to them by licence.

## Language

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

### Admin

**Admin**:
A user who can use the admin pages, currently one whose `sub` is in `ADMIN_USERS`.
_Avoid_: Administrator, superuser, staff

**Admin pages**:
The server-rendered admin UI at `/admin/` on the admin origin (`ADMIN_ORIGIN`).
_Avoid_: Portal, admin API
