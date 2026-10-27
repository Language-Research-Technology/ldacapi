# The admin pages are server-rendered and the only way into admin

## Context

Admins manage the API's indexes. A separate browser app calling an admin API with one shared key exposes the key to anyone who loads the app, records nobody's identity, and can only take access away from everyone at once. The API is already an OIDC provider that signs users in at the upstream provider (ADR 0001), and it can reach the repository and indexer directly.

## Decision

The API serves its own admin pages at `/admin/`, rendered on the server, on the issuer's origin and outside `/api`. They are registered only when sign-in is configured.

- The admin pages are a built-in confidential client of our provider, not listed in `OIDC_CLIENTS`. Its client secret is derived from `OIDC_COOKIE_KEYS` with HKDF, and it uses only the authorisation code grant, asking for `openid profile`.
- Sign-in is a server-side authorisation code flow with PKCE, state and nonce. The browser goes through the provider as usual, but the token request reaches the provider in-process, with its metadata built from configuration rather than discovery, so the API never calls its own public URL. Only the ID token is kept.
- Each sign-in's state, PKCE verifier, nonce and page to return to are held in a short-lived encrypted cookie. The session is an encrypted cookie holding the `sub`, sign-in time and ID token, with an absolute lifetime of 8 hours. Both cookies are scoped to `/admin`, `HttpOnly`, `Secure` on an https issuer, and `SameSite=Lax`, because sign-in returns through a redirect chain that started at the upstream provider, where a `Strict` cookie wouldn't be sent. Their keys are derived from every key in `OIDC_COOKIE_KEYS`, so they rotate with it.
- An admin is a user whose `sub` is in `ADMIN_USERS`, checked on every request. Others who sign in get a 403 page showing their `sub`.
- Signing out clears the session and ends the session at our provider, via its end-session endpoint with the ID token as `id_token_hint`.
- Every POST must carry an `Origin` matching the issuer. Responses carry a Content-Security-Policy allowing only same-origin scripts and styles, and no framing.
- Pages are built with an `html` tagged template that escapes every interpolated value.

## Consequences

- There is no shared admin secret, and each admin acts as themselves.
- Removing an admin from `ADMIN_USERS` takes effect when the API restarts, whatever sessions they hold.
- Signing out of the admin pages also signs the user out of our provider, which Oni relies on; Oni keeps working until its tokens can't be refreshed. It doesn't sign them out at the upstream provider.
- Admin needs sign-in configured, and so a working upstream provider, even locally.
- A non-human caller has no way into admin.
