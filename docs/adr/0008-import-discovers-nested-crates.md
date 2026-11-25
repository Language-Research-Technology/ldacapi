# Import discovers nested crates

## Context

Several projects import their own RO-Crates with `pnpm crates:import`. Their crates are often laid out as nested collections: a collection's folder holds its members' folders, sometimes grouped further, each with its own `ro-crate-metadata.json`. Source directories also pick up things nobody means to archive, such as `.git` folders, `.DS_Store` files and symlinks, and a large tree makes a copied crate more likely.

A collection, object or file belongs to exactly one crate, and the repository is an archive: every earlier version of a crate must stay readable.

## Decision

- **Discovery.** The import walks the source directory recursively, the directory itself included. Every folder holding `ro-crate-metadata.json` is a crate, at any depth, and the walk goes on inside crates to find the crates below them.
- **Nested crates are left out of the crate above.** A crate's import leaves out the folders of crates below it, using `@ocfl/ocfl-fs`'s import filter. Folders between the two that hold no metadata stay part of the crate above: for `coll/batch/item1`, `coll` holds `batch/` but not `batch/item1/`.
- **Nesting on disk means nothing else.** Which collection a crate belongs to comes only from `pcdm:memberOf` and `pcdm:hasMember` in its metadata, as for distributed crates.
- **Hidden entries** (any name starting with `.`) are left out everywhere, between crates and inside them. OS clutter (`.DS_Store`, `._*`, `.Spotlight-V100`, `.Trashes`, `.fseventsd`) is left out silently. Any other hidden entry, `.git` included, is left out with one warning naming its path. A hidden folder is not read, so it warns once.
- **Symlinks** are never followed. Each is left out with a warning, and the crate holding it still imports.
- **Folders that lead to no crate.** Outside crates, the import warns about the highest folder whose contents hold no crate, and not about the folders below it. It warns when the source directory holds no crate at all. Warnings don't fail the run.
- **Errors.** A folder that can't be read, including a source directory that doesn't exist, is skipped, as is a crate whose metadata can't be read, has no root dataset, or has a root `@id` that isn't an absolute IRI (such as `./`, a crate with no id of its own), with one error naming its folder and the id. When folders share an absolute root `@id`, none of them is imported, and the error names every folder. Every crate is found and read before any is written, so a duplicate is caught before either copy is. The run goes on past errors and fails at the end if there were any.
- **Modes.** `--mode` is required, with no default:
  - **Sync** makes each crate's new version hold exactly what its folder holds.
  - **Add** adds and replaces files from the folder, and removes none.

  In both modes, a crate whose folder is unchanged gets no new version, earlier versions are kept, and no crate is ever deleted.

## Consequences

- A crate's files never land in the crate above it, however deep the layout.
- A collection whose metadata describes files held in a nested crate gets the indexer's "Files described but not held" warning for them. The import doesn't look into other crates to explain it.
- A file an earlier version held at a path that now belongs to a nested crate stays in the crate above under Add, and is dropped from its new version under Sync. Restructuring an archive beyond that takes a script of its own.
- There is no way to import a hidden entry or follow a symlink. That needs an option when a project asks for it.
- A source directory that doesn't exist fails the run. One that exists but holds no crate gives a warning and a successful run.
