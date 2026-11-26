# File requests take the access token from a cookie

## Context

Clients authenticate with our access tokens as bearer tokens (ADR 0001). Oni downloads a file by navigating to its `/api/file/:id` URL, and plays, shows or previews it by using that URL as an `<audio>`, `<video>` or `<img>` source, or fetching it with no headers. None of these can carry an `Authorization` header, so a restricted file is refused with 401 even to a user who holds its licence.

The API streams files from the OCFL repository itself, through arocapi's file route, which adds Range support, validators, `nosniff` and a `sandbox` Content-Security-Policy. Oni and the API are on the same host in every LDaCA deployment: Oni at `/`, the API at `/api`. Access tokens last 15 minutes, and Oni renews them silently before they expire.

## Decision

- **The token cookie.** Oni, when configured with `api.rocrate.tokenCookie`, keeps its current access token in a cookie named `oni_access_token`: host-only (no `Domain`), `Path=/api/file/`, `Secure`, `SameSite=Strict`, expiring with the token. Oni sets it from JavaScript, so it isn't `HttpOnly`; the same token is already readable in Oni's `localStorage`.
- **Where the API reads it.** A bearer token is used when present. Otherwise, on the file route only, the API reads the token from the cookie and checks it exactly as it checks a bearer token. Every other route ignores the cookie, so no route a forged cross-site request could reach is authenticated by it.
- **Requests another site can't cause.** The cookie counts only when `Sec-Fetch-Site` is `same-origin` (Oni's pages), `none` (the user reloading a file, opening a bookmark or retrying a download), or absent, as from browsers too old to send it. `SameSite=Strict` stops sites outside the registrable domain, but pages on sibling subdomains are same-site, and refusing `same-site` stops them using a visitor's cookie to probe which licences the visitor holds.
- **One cookie only.** When the request carries more than one `oni_access_token`, as when a sibling subdomain has set its own for the parent domain, the API ignores them all.
- **arocapi serves the file.** Its file route streams it with its own headers, and sends no redirect.

## Consequences

- Restricted files download, play, seek and preview in Oni, for every user who holds the licence, with arocapi's protective headers intact.
- It works only when the API is on Oni's origin. With the API on another port of the same host, `<img>`, media and downloads work but `fetch`-based previews don't. Clients on other hosts keep using bearer tokens.
- Cookie-authenticated responses aren't protected from shared caches the way bearer-authenticated ones are, so wherever the cookie is used, file responses must carry `Cache-Control: private` (crate-works/arocapi#151).
- A browser that doesn't send `Sec-Fetch-Site` relies on `SameSite=Strict` alone, so a page on a sibling subdomain could probe it. A sibling subdomain can also make a user's file requests fail by planting a second cookie, but can't act as another user.
- A media element or download has no retry when the token lapses: if a silent renewal fails, a seek errors and a download shows the API's 401 until the user signs in again.
