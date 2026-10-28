# The admin pages are server-rendered and the only way into admin

## Context

Admins manage the API's indexes. A separate browser app calling an admin API with one shared key exposes the key to anyone who loads the app, records nobody's identity, and can only take access away from everyone at once. The API is already an OIDC provider that signs users in at the upstream provider (ADR 0001), and it can reach the repository and indexer directly. It also serves crate files inline with their own content type and no sandbox, so HTML or SVG in a crate runs script on the API's origin.

## Decision

The API serves its own admin pages at `/admin/`, rendered on the server, in the API's process but on their own origin, `ADMIN_ORIGIN`, which must differ from the issuer's. Every admin route is constrained to the admin origin's host, and nothing else is served there, so script in a crate file runs on another origin than admin, with the browser's boundary between them. They are registered only when sign-in and `ADMIN_ORIGIN` are configured. They are the only way into admin: there is no admin API and no shared admin key, and the pages call the repository directly.

- The admin pages are a built-in confidential client of our provider, not listed in `OIDC_CLIENTS`. Its client secret is derived from `OIDC_COOKIE_KEYS` with HKDF, and it uses only the authorisation code grant, asking for `openid profile`.
- Sign-in is a server-side authorisation code flow with PKCE, state and nonce. The browser goes through the provider as usual, but the token request reaches the provider in-process, with its metadata built from configuration rather than discovery, so the API never calls its own public URL. Only the ID token is kept.
- Each sign-in's state, PKCE verifier, nonce and page to return to are held in a short-lived encrypted cookie. The session is an encrypted cookie holding the `sub`, sign-in time and ID token, with an absolute lifetime of 8 hours. Both cookies are on the admin origin, scoped to `/admin`, `HttpOnly`, `Secure` on an https admin origin, and `SameSite=Lax`, because sign-in returns through a redirect chain that started at the upstream provider, where a `Strict` cookie wouldn't be sent. Their keys are derived from every key in `OIDC_COOKIE_KEYS`, so they rotate with it.
- An admin is a user whose `sub` is in `ADMIN_USERS`, checked on every request. Others who sign in get a 403 page showing their `sub`.
- Signing out clears the session and ends the session at our provider, via its end-session endpoint with the ID token as `id_token_hint`, which returns to a signed-out page that needs no session. Returning to an admin page instead would sign the admin straight back in while their upstream session lasts.
- Every action is a POST form that redirects back to the page with a one-time flash message, so reloading doesn't repeat it. An action on a crate covers it and the crates under it, and each action, accepted or refused, is logged with the admin's `sub`. A POST without a session signs in and returns to the home page, as only a GET can be repeated.
- Every POST must carry an `Origin` matching the admin origin. Responses carry a Content-Security-Policy allowing only same-origin scripts and styles, and no framing.
- Pages are rendered with `@fastify/view` and Eta templates in `src/admin/views/`, which escape every value by default; unescaped output is only for a layout's body or an included template.

## Consequences

- There is no shared admin secret, and each admin acts as themselves.
- Removing an admin from `ADMIN_USERS` takes effect when the API restarts, whatever sessions they hold.
- Signing out of the admin pages also signs the user out of our provider, which Oni relies on; Oni keeps working until its tokens can't be refreshed. It doesn't sign them out at the upstream provider.
- Admin needs sign-in configured, and so a working upstream provider, even locally.
- Admin needs a second hostname, which the reverse proxy routes to the API with its `Host` header unchanged. Locally it is `admin.localhost`, which browsers resolve to the machine.
- A non-human caller has no way into admin.
- Templates aren't type-checked or linted. Each page's data is typed where the TypeScript passes it to its template, and what the templates compute is kept to looping and printing.
