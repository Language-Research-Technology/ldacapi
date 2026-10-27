# The API is its own OIDC provider

## Context

The ro-crate-api spec describes the OAuth2 authorisation code flow with OIDC discovery for user-facing clients, and leaves the provider implementation-specific. Oni signs users in as a public client with PKCE and reads the user's name and email from the ID token. Users already have identities at CILogon, which gives public clients only the `openid` scope; name and email need a confidential client, so something holding a client secret has to sit between Oni and CILogon. REMS knows users by CILogon's subject identifier. The API must check a bearer token on every request without calling another service.

## Decision

The API is an OIDC provider, built on `oidc-provider`, with its own issuer. It sends users to sign in at one upstream provider chosen by configuration, and issues its own ID, access and refresh tokens once they return.

## Consequences

- The upstream provider must speak OIDC, and there is never a page for choosing one.
- Our `sub` is the upstream provider's `sub`, because REMS signs in at the same upstream provider and knows users by it. Changing the upstream provider gives every user a new identity, in REMS as well as here.
- Only clients listed in configuration can get tokens. Oni is a public client using PKCE.
- Access tokens are short-lived JWTs that the API checks itself. Revoking a grant doesn't cut off access tokens already issued from it; they keep working until they expire, at most 15 minutes later.
- Discovery is at `/.well-known/openid-configuration`, and the other endpoints are under `/oauth/`, as in the spec.
- Provider state lives in Postgres. The keys that sign tokens and cookies come from the environment, so rotating them is a configuration change.
