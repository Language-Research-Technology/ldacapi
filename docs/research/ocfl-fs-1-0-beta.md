# What `@ocfl/ocfl-fs` 1.0 beta offers for change detection and reading

Research for #67, under the indexer redesign map (#65). Facts only; the design choices they feed belong to the grilling tickets.

## Sources

- **Installed package:** `@ocfl/ocfl-fs` 1.0.0-beta.59, which ships its TypeScript source (`node_modules/@ocfl/ocfl-fs/src/`). It is self-contained: there is no separate `@ocfl/ocfl` dependency in 1.0 (its `package.json` has no `dependencies`). Paths below like `src/list.ts` are in that package.
- **ocfl-js repository** at `main` 6dc9df2 (2026-11-17): the website guides `website/src/content/docs/guides/concurrent-writers.mdx` and `use-cases.mdx`, ADRs 0005 to 0007 in `docs/adr/`, `docs/consumers.md`, and the commits since the `v1.0.0-beta.59` tag.
- **OCFL 1.1 spec**, as vendored at `resources/ocfl_1.1.md` in ocfl-js (the same text the library writes into every storage root it creates).
- **ldacapi** at ec91b82: `src/ocfl.ts`, `src/ocfl-repository.ts`, `src/indexer/database.ts`, `scripts/crates-import.ts`; and arocapi 5.0.0-beta.10's `dist/storage/ocfl/ocfl.js`.

## Short answer

- There is **no persistent change token in the public API**. An opened object gives `head.number` and `head.createdAt`; the inventory digest the library computes is internal (`_digest`). `object.isCurrent()` is cheap (one `stat`) but only compares against an object held in memory.
- Getting anything about an object, even its head number, means **reading, parsing and hashing its whole root inventory**. There is no cheaper read in the API except `root.has(id)`, which says only whether it exists.
- **Listing** is a streaming async iterator over a directory walk, one object at a time, with no order, pagination, cursor, prefix filter or resume. Every object it yields has had its inventory read and checked.
- **File metadata** (logical path, digest, `modifiedAt`) comes from the inventory with no file I/O; `size()` is one `stat`. Files a crate lists but the OCFL object doesn't hold have no `OcflFile` at all.
- **Readers take no lock and never wait.** A commit has a single atomic commit point (the rename of the root inventory); an opened object is a snapshot that a later commit doesn't change. Writers lock each object and refuse a second writer rather than queue it.
- Unreleased on ocfl-js `main`, and **breaking for code ldacapi has today**: `openStorageRoot` on a missing or empty path throws `STORAGE_ROOT_NOT_FOUND` instead of `INVALID_STORAGE_ROOT`/E069 (which `src/ocfl-repository.ts` tests for), and `draft.import(source, target)` becomes `draft.import(source, { target, filter })`.

## 1. Detecting change

### What the API exposes

- `OcflObject.head` is a `Version` with `number`, `createdAt`, optional `message` and `user`, and `files` (`src/ocfl-object.ts`, interfaces `Version` and `OcflObject`). `OcflObject.versions` maps every version number to its `Version`.
- `OcflObject.isCurrent()`: "Whether the object's root inventory is still the file this object was read from: `false` once it has been replaced, changed or removed. Every commit replaces the root inventory, so a commit by any writer makes it `false`." It does "one `stat` of the root inventory, comparing its device, inode, size and modification time with those noted when it was read". It is "a cheap check, not a guarantee": an inode reused for a same-size, same-mtime inventory could still give `true` (`src/ocfl-object.ts`, doc comment and `isCurrent()`; `src/file-system.ts`, `FileIdentity` is `{ dev, ino, size, mtimeNs }`).
- The identity `isCurrent()` compares against is private (`inventory._identity`), so it can't be stored and compared after a restart. It works only for an `OcflObject` kept in memory.
- The inventory's digest is computed on every open (`src/object-on-disk.ts`, `readInventoryAttempt`: `inventory._digest = actual`) but is not on the public `OcflObject` interface. The public API report (`docs/ocfl-fs.api.md` in ocfl-js) lists no digest of the inventory.
- `OcflFile.digest` (each file's content digest, from the inventory) and `OcflFile.modifiedIn` / `modifiedAt` (the version that gave the logical path its current content) are public (`src/ocfl-file.ts`).
- There is no watch, event or "changed since" API anywhere in the package (`src/index.ts` exports only the storage root, object, file, draft, error and layout types).

### What reading the head costs

- `root.open(id)` reads the whole root `inventory.json`, parses it, reads the sidecar `inventory.json.sha512` (or `.sha256`), hashes the inventory and compares, validates its structure, checks the object declaration and that it isn't nested in another object (`src/ocfl-object.ts`, `openObject`; `src/object-on-disk.ts`, `committedInventory`, `readInventoryAttempt`, `confirmedVersion`).
- The ocfl-js use-cases guide says so directly: "`isCurrent()` costs one `stat` of the root inventory, where opening reads and checks the whole inventory."
- `root.has(id)` reads no inventory: it checks that the root inventory or object declaration exists (and, with only a declaration, whether a create holds the lock) (`src/storage-root.ts`, `has`; `src/object-on-disk.ts`, `objectState`). It gives no head or digest.

### What OCFL 1.1 guarantees on disk

- Every inventory has a sidecar `inventory.json.ALGORITHM` holding `DIGEST inventory.json` (spec §3.6, E058, E060, E061), and "writing the digest sidecar file is the last step in the versioning process" (E062).
- The root inventory "MUST be the same as the file in the most recent version" where version directories hold inventories (§3.7, E064). Version directories are "expected to be immutable" (§3.3, §3.7.1).
- So the sidecar's digest changes whenever the root inventory changes. The library doesn't expose it, and doesn't give out object root paths (ADR 0006, "The library gives out no paths on disk"), but `StorageRoot.layout` is public and the layout maps id to object root deterministically (spec §4.3, E083).
- In ocfl-fs, the sidecar briefly lags the root inventory during a commit: "A commit replaces the root inventory and then its sidecar, so between the two the root inventory is right and its sidecar is not" (`src/object-on-disk.ts`, `isHeadVersionInventory`; `src/draft.ts`, `#replaceRootInventory`). The library's own reader tolerates this only while the writer's lock is held or on a re-read (ADR 0007's one allowance). A reader of the sidecar outside the library would see the old digest in that window.

### What ldacapi uses today

- `src/ocfl.ts` keeps index state in an in-memory `stateCache` and infers "indexed" from whether the indexers count any rows for the crate (`getState`). It records no head version, date or digest, so it can't tell whether a crate changed since it was indexed.

## 2. Listing objects

- `StorageRoot.objects(): AsyncIterable<ListedObject>`: "Lists every object in the storage root, in no particular order. Each object is read when the listing reaches it". "Leaving the loop early closes every directory the listing opened." (`src/storage-root.ts`.)
- Implementation (`src/list.ts`): a recursive walk with `fs.promises.opendir`, so directory entries stream rather than load whole. In each directory it tries to read the object declaration (`0=ocfl_object_1.0` / `1.1`); a directory with one is opened as an object (full inventory read and check, as above) and not descended into; one without is descended into. It processes one entry at a time, awaiting each open before moving on: there is no concurrency.
- No pagination, cursor, ordering, prefix or id filter, count, or resume point. Ids are only known after each inventory is read; the layout maps id to path, not path to id.
- Damaged objects are yielded as `{ error, objectRoot, id? }` (always `INVALID_OBJECT`, with `ocflCode` where there is one) and the listing carries on. A file system error ends the listing by throwing. A create that hasn't committed is left out silently, as is a directory that has lost its declaration (`src/list.ts`; concurrent-writers guide, "A create whose writer died").
- The use-cases guide: "Reading it lazily keeps memory use flat however large the storage root is, and breaking out of the loop stops the walk."
- ldacapi today: `readableObjects()` in `src/ocfl.ts` wraps `objects()`, logging damaged entries. `createIndex` with a pattern or no ids first walks every object to collect ids (`idsMatching`), then opens each again in `indexObject` (`loadObject` → `repository.open`), so each inventory is read at least twice per run. `topCollectionFinder` opens parent crates again (cached per run). `objects()` in `src/ocfl.ts` reads every crate's `ro-crate-metadata.json` to get its name.

## 3. Reading metadata and file metadata

- Reading `ro-crate-metadata.json` means `root.open(id)` (full inventory) then `head.files.get('ro-crate-metadata.json')?.text()`. There is no way to read one file without opening the object.
- `Version.files` is built on first access from the inventory, with no file I/O: "Listed on first use: an object can have many versions of many files, and most readers want only the head" (`src/ocfl-object.ts`, `ObjectVersion.files`).
- Per file, without reading content (`src/ocfl-file.ts`):
  - `path` (logical path) and `digest` (lowercase hex, in `object.digestAlgorithm`, sha512 for objects this library creates): from the inventory, no I/O.
  - `createdIn` / `createdAt`, `modifiedIn` / `modifiedAt`: from the inventory's version history, no I/O. "From the inventory, never from the stored file".
  - `size()`: one `stat` of the stored file. It rejects if the stored file is missing (with `ENOENT` in beta.59; with `OcflError` `INVALID_OBJECT` after the unreleased fix bb48d50) or isn't a regular file.
  - `stream(range?)`, `text()`, `bytes()` read content.
- The library gives out no content paths (ADR 0006); content is read only through `stream()`, `text()` or `bytes()`.
- **Metadata-only crates.** An OCFL inventory lists only files the object holds (spec §3.5.2 manifest, §3.5.3 state). A file the RO-Crate lists but the object doesn't hold has no entry, so `head.files.get(path)` is `undefined`, and the library has no size or digest for it. Today `wrap()` in `src/ocfl.ts` throws `File not found in ocfl inventory`; `src/indexer/database.ts` catches it, logs `Cannot read file` at error level, and falls back to the crate's stated `contentSize`.
- arocapi 5.0.0-beta.10's `OcflStorage` (`dist/storage/ocfl/ocfl.js`) opens the object on every request (`storageRoot.open`), and serves `file.stream()`, `file.size()`, `"${file.digest}"` as ETag and `file.modifiedAt` as Last-Modified. It doesn't cache objects or use `isCurrent()`.

## 4. Writing, and writers alongside an indexer

### What each path needs

- **Index in place** needs only `openStorageRoot`, `objects()` or `open()`, and file reads. None of these write: opening a storage root reads its declaration, `ocfl_layout.json` and layout config (`src/storage-root.ts`, `readStorageRoot`); reading an object reads its inventory, sidecar and declaration, and checks for a lock file only when the sidecar doesn't match (`src/object-on-disk.ts`). ADR 0005: a storage root without hard links "can be read but not written".
- **Import and Deposit** need `createStorageRoot` (once), `root.create(id, details, build)` and `object.update(details, change)`, with a `Draft` offering `write`, `import`, `copy`, `rename`, `reinstate`, `remove`, `clear` and `files()` (`src/draft.ts`). Both take `VersionDetails` (`message`, `user`, optional `createdAt`) and `UpdateOptions.signal` for cancelling.
- An update that changes nothing commits no version and returns the same object (`OcflObject.update` doc). Content already in the object isn't stored again (use-cases guide, "A deposit service").
- `draft.import` adds and replaces files but keeps the rest: "Files already there are replaced; the rest stay" (`src/draft.ts`). The use-cases guide calls `draft.clear()` first so a version holds exactly the new deposit. `scripts/crates-import.ts` calls `object.update(details, (draft) => draft.import(path))` without `clear()`, so a file removed from a source crate stays in the next version.
- `import` refuses symlinks (`UNSUPPORTED_FILE_TYPE`) and throws `SOURCE_CHANGED` if a file changes while being copied.

### Locking and concurrency

- Each object has one lock file in the storage root's workspace (`extensions/ocfl-js-workspace/<object path>/lock`). `create`, `update` and `remove` take it first and release it only when they end cleanly. A second writer gets `UPDATE_IN_PROGRESS`; the library "never waits, queues or retries" (concurrent-writers guide; ADR 0005; `src/lock.ts` header).
- "Readers take no lock, so opening an object or reading its files never waits on a writer." (concurrent-writers guide.)
- An update is committed at one moment, "the rename that replaces the object's root `inventory.json`" (concurrent-writers guide; `src/draft.ts`, `#replaceRootInventory`). A reader sees either the old or the new root inventory, never a half-written one.
- "An opened OCFL object is the object as read at one moment. It doesn't change when another writer commits a later version or removes the object." Because version directories aren't changed by later commits (spec §3.7.1), files of the snapshot stay readable after a new version is committed.
- `remove` deletes the object root, with "What opening the object reads goes last, so that a reader meanwhile finds the object, not a damaged one" (`src/remove.ts`, `deleteObjectRoot`). So during a remove, an object can open and then have files missing; "A stored file removed once the stream is open is still read in full" (use-cases guide).
- A dead writer leaves its lock; the object stays readable, and `root.unfinishedWrites()` / `write.recover()` clear it only on the caller's word that the writer is dead (ADR 0005). Recovery must run in one process at a time.
- The lock only keeps apart writers that take it: ocfl-js 0.4 and pre-lock betas don't, nor do other tools (concurrent-writers guide, "Upgrade every writer together").
- Platform: Linux only, case-sensitive file system with hard links; NFS 4.1+ recommended for shared storage roots (README; concurrent-writers guide).

## 5. What 1.0 has that ldacapi doesn't use yet

ldacapi uses `openStorageRoot`, `createStorageRoot`, `OcflError` (`code`, `ocflCode`), `objects()`, `open()`, `head.files.get()`, `file.text()`, `file.size()`, and in `scripts/crates-import.ts` `create`/`update` with `draft.import`.

Unused and relevant to the indexer:

- `OcflObject.head.number` and `head.createdAt`, and `versions`.
- `OcflObject.isCurrent()`, for an object kept in memory.
- `root.has(id)`, existence without reading the inventory.
- `OcflFile.digest`, `modifiedIn` / `modifiedAt`, `createdIn` / `createdAt`, all without I/O.
- `OcflObject.checkFixity({ signal, onProgress })`.
- `root.unfinishedWrites()`, `root.unfinishedWrite(id)` and `UnfinishedWrite.recover()`.
- `Draft.files()` (the draft's paths and digests), `clear()`, `copy`, `rename`, `reinstate`, `remove`; `UpdateOptions.signal`.

### Unreleased on ocfl-js `main` (after beta.59)

From `git log v1.0.0-beta.59..main`:

- 42550f8 `feat!`: `openStorageRoot` on a path that doesn't exist, or an empty directory, throws `STORAGE_ROOT_NOT_FOUND` with no `ocflCode`, instead of `INVALID_STORAGE_ROOT` (E069). `isMissing()` in `src/ocfl-repository.ts` tests for the old error.
- bb48d50 `fix!`: `size()`, `stream()`, `text()` and `bytes()` reject a missing stored file with `OcflError` `INVALID_OBJECT` (Node error as `cause`), not `ENOENT`.
- 3b84570 `feat!`: `draft.import(source, { target, filter })`; a string second argument throws `TypeError`. The filter gets each entry's relative path and `fs.Dirent`, and can leave out entries such as `.git`, `.DS_Store` or symlinks. ldacapi's one call, `draft.import(path)`, has no second argument.
