# Changesets

This folder holds [changesets](https://github.com/changesets/changesets) — one Markdown file per pending change describing the version bump and a human-readable summary.

- Add one with `pnpm changeset` (pick the affected packages and bump type).
- All `@sovecom/*` packages are **fixed-versioned together** (see `config.json`), so they share one version number.
- Release flow: `pnpm changeset:version` (apply bumps + update changelogs) then `pnpm changeset:publish`.

For full docs see the [changesets repo](https://github.com/changesets/changesets/blob/main/docs/intro-to-using-changesets.md).
