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
