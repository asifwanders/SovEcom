# Releasing SovEcom

This document describes how to cut a release of SovEcom. Follow the checklist below for every release.

## How Releases Work

Pushing a git tag `vX.Y.Z` to the main branch triggers `.github/workflows/release.yml`, which:

1. **Runs tests, linting, and typechecks** to ensure the release is clean.
2. **Builds multi-architecture Docker images** (amd64 and arm64) for:
   - `sovecom-api`
   - `sovecom-admin`
   - `sovecom-setup`
   - `sovecom-storefront`
3. **Pushes images to GHCR** with up to three tags per image:
   - Exact version: `ghcr.io/asifwanders/sovecom-{api,admin,setup,storefront}:1.2.3`
   - Minor version: `ghcr.io/asifwanders/sovecom-{api,admin,setup,storefront}:1.2`
   - Latest: `ghcr.io/asifwanders/sovecom-{api,admin,setup,storefront}:latest` — **only applied for stable tags** (no pre-release suffix). Pre-release tags (e.g. `-rc.1`) do **not** receive `:latest`.
4. **Publishes npm packages** to the `@sovecom` organization:
   - `@sovecom/module-sdk` — module SDK
   - `@sovecom/theme-sdk` — theme SDK
   - `@sovecom/client-js` — typed JavaScript client
   - `create-sovecom-module` — module scaffolder
   - `create-sovecom-theme` — theme scaffolder
5. **Creates a GitHub Release** with auto-generated release notes.

## Release Cadence Policy

- **Patch releases** (`1.0.x`): as-needed, target weekly
- **Minor releases** (`1.x.0`): monthly
- **Major releases** (`x.0.0`): annual at most, with a 6-month deprecation notice for breaking changes

## Versioning

SovEcom follows [Semantic Versioning](https://semver.org/). Use Changesets to manage versions:

- **Record a change**: `pnpm changeset` — prompts for which packages changed, what kind of change (major/minor/patch), and a summary.
- **Bump versions**: `pnpm version-packages` — applies all recorded changesets and bumps version numbers in all `package.json` files.

### Pre-releases

Pre-releases use the tags `-rc.N` (release candidate) or `-beta.N`:

```bash
# Example: cutting a release candidate snapshot
# (generates versions like 1.2.0-rc-20240626120000 in a snapshot; bump manually for a proper tag)
pnpm changeset version --snapshot rc
# Then build, tag, and push manually (see checklist below)

# Publish the pre-release snapshot to npm under the rc dist-tag
pnpm changeset publish --tag rc
```

Mark the GitHub Release as a pre-release when you create it.

## Per-Release Checklist

Before pushing the tag and triggering the workflow, complete these steps:

- [ ] CHANGELOG.md updated with notable changes since the last release
- [ ] Version numbers bumped in all package.json files (via `pnpm version-packages`)
- [ ] Migration guide updated if there are breaking changes
- [ ] Security advisory drafted if this is a security release
- [ ] Pre-disclosure sent to paid customers (if security release)
- [ ] Git tag created: `git tag -a vX.Y.Z -m "Release X.Y.Z"` and pushed: `git push origin vX.Y.Z`
- [ ] CI release workflow completes successfully
- [ ] Docker images verified pullable (see Verification below)
- [ ] npm packages verified installable (see Verification below)
- [ ] Blog post drafted (for minor/major releases)
- [ ] Social posts scheduled (for minor/major releases)

## Prerequisites & Secrets

The following must be configured in your GitHub repository settings for the release workflow to function:

### Required Secrets

- **`NPM_TOKEN`** — npm automation token for the `@sovecom` organization. Create one at https://www.npmjs.com/settings/~/tokens and paste it as a repository secret.
- **`GITHUB_TOKEN`** — automatically provided by GitHub Actions; no manual setup needed. Used to push to GHCR and create releases.

### Required Permissions

- GitHub Actions must be enabled for the repository.
- The repository must have permission to push to GHCR (`ghcr.io`).
- The `@sovecom` organization on npm must exist, and the `NPM_TOKEN` must have publish permission for all packages.

### Current Status

**GitHub Actions billing is currently disabled.** If the release workflow fails with "Actions billing disabled," follow the manual fallback steps below until billing is enabled.

## Manual Fallback (When GitHub Actions Billing Is Disabled)

If the release workflow cannot run, complete the following steps locally and push manually:

```bash
# 1. Ensure you're on main and up-to-date
git checkout main
git pull origin main

# 2. Create and push the tag
git tag -a vX.Y.Z -m "Release X.Y.Z"
git push origin vX.Y.Z

# 3. Build and push Docker images
# Requires: Docker, docker buildx, and credentials to push to ghcr.io
export VERSION=X.Y.Z
docker buildx build --platform linux/amd64,linux/arm64 \
  -t ghcr.io/asifwanders/sovecom-api:${VERSION} \
  -t ghcr.io/asifwanders/sovecom-api:${VERSION%.*} \
  -t ghcr.io/asifwanders/sovecom-api:latest \
  -f docker/Dockerfile.api --push .

docker buildx build --platform linux/amd64,linux/arm64 \
  -t ghcr.io/asifwanders/sovecom-admin:${VERSION} \
  -t ghcr.io/asifwanders/sovecom-admin:${VERSION%.*} \
  -t ghcr.io/asifwanders/sovecom-admin:latest \
  -f docker/Dockerfile.admin --push .

docker buildx build --platform linux/amd64,linux/arm64 \
  -t ghcr.io/asifwanders/sovecom-setup:${VERSION} \
  -t ghcr.io/asifwanders/sovecom-setup:${VERSION%.*} \
  -t ghcr.io/asifwanders/sovecom-setup:latest \
  -f docker/Dockerfile.setup --push .

docker buildx build --platform linux/amd64,linux/arm64 \
  -t ghcr.io/asifwanders/sovecom-storefront:${VERSION} \
  -t ghcr.io/asifwanders/sovecom-storefront:${VERSION%.*} \
  -t ghcr.io/asifwanders/sovecom-storefront:latest \
  -f docker/Dockerfile.storefront --push .

# 4. Publish npm packages
pnpm changeset:publish

# 5. Create the GitHub Release manually
# Visit https://github.com/asifwanders/sovecom/releases and click "Draft a new release"
# Select the vX.Y.Z tag, write release notes, and publish.
```

## Verify a Release

### Docker Images

```bash
# Pull an image to verify it exists and is accessible
docker pull ghcr.io/asifwanders/sovecom-api:1.2.3

# Inspect the manifest to confirm both architectures were pushed
docker manifest inspect ghcr.io/asifwanders/sovecom-api:1.2.3
```

### npm Packages

```bash
# Check that a package is published and installable
npm view @sovecom/client-js@1.2.3

# If publishing a pre-release, verify the dist-tag
npm view @sovecom/client-js@1.2.0-rc.1
npm dist-tag ls @sovecom/client-js
```

## Notes

- **Never delete a release tag.** Consumers may rely on it. If a release is broken, cut a patch release instead.
- **Do not release on a Friday or before a holiday.** If a bug surfaces, you'll need time to issue a patch.
- **Security releases should be coordinated with the security team.** See `SECURITY.md` for disclosure procedures.
