# Every entity is visible; access is by licence alone

## Context

arocapi separates two controls. Visibility decides whether an entity exists for a request at all: the entity and search visibility filters drop it from lookups, listings and search results. Access decides what a request may read of an entity it can see, by the entity's metadata and content licences. LDaCA's collections are discoverable by design, and what restricts them is their licences, granted through REMS.

## Decision

Every indexed entity is visible to every request, signed in or not. The API uses arocapi's `AllVisibleEntityFilter` and `AllVisibleSearchFilter`, and has no visibility rules of its own. Restriction is by licence only: `LicenceAccess` grants a licence that is one of the open licences in `src/configuration.ts` or that the user holds an entitlement to in REMS.

## Consequences

- Anyone can find any entity through lookups, listings and search, including those whose licences they don't hold, and see that it is restricted and how to apply for access.
- Hiding an entity means not indexing it; there is no per-request way to hide it.
- Because the two visibility filters return no conditions, they always agree with each other.
