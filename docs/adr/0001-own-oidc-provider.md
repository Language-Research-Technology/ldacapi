# The API is its own OIDC provider

The ro-crate-api spec requires an API that protects data to implement OAuth2 on its own host, with OIDC discovery recommended. The API is therefore an OIDC provider (built on `oidc-provider`) with its own issuer, and sends users to sign in at one upstream provider chosen by configuration. It does not relay requests to another provider. Relaying left a discovery document whose issuer belonged to a different domain, tied us to one provider, and existed mainly so we could inject a client secret for Oni.

## Consequences

- The upstream provider must speak OIDC, and there is never a page for choosing one.
- Our `sub` is the upstream provider's `sub`, because REMS signs in at the same upstream provider and knows users by it. Changing the upstream provider gives every user a new identity, in REMS as well as here.
- Only clients listed in configuration can get tokens. Oni is a public client using PKCE.
- Access tokens are short-lived JWTs that the API checks itself.
- Discovery is at `/.well-known/openid-configuration`, and the other endpoints are under `/oauth/`, as in the spec.
- Provider state and signing keys live in Postgres.
