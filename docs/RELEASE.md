# Release

All workspaces share one version and release together.

## Standard release (patch)

```bash
npm run release:patch
```

This bumps the version across all workspaces, runs checks, publishes to npm, and pushes the branch + tag (triggering desktop, APK, and EAS mobile workflows).

If asked to "release paseo" without specifying major/minor, treat it as a patch release.

## Manual step-by-step

```bash
npm run version:all:patch    # Bump version, create commit + tag
npm run release:check        # Validate release
npm run release:publish      # Publish to npm
npm run release:push         # Push HEAD + tag (triggers CI workflows)
```

## Draft release flow

```bash
npm run draft-release:patch    # Bump, push tag, create draft GitHub Release
npm run release:finalize       # Publish npm, promote draft to published
```

- `draft-release:patch` creates the GitHub Release as a draft so desktop assets, APK uploads, and synced notes attach to it
- `release:finalize` publishes npm and promotes the same draft release
- Use the same semver tag for both; don't cut a second tag
- Desktop assets now come from the Electron package at `packages/desktop`

## Fixing a failed release build

**NEVER bump the version to fix a build problem.** New versions are reserved for meaningful product changes (features, fixes, improvements). Build/CI failures are fixed on the current version.

**NEVER use `workflow_dispatch` to retry release builds.** The `workflow_dispatch` trigger runs the workflow file from the default branch but checks out the code at the tag ref (`ref: ${{ inputs.tag }}`). This means build fixes committed to `main` won't be picked up — the old broken code at the tag gets built again.

To retry a failed workflow, **always push a retry tag** on the commit you want to build:

```bash
# Desktop (all platforms)
git tag -f desktop-v0.1.28 HEAD && git push origin desktop-v0.1.28 --force

# Desktop (single platform)
git tag -f desktop-macos-v0.1.28 HEAD && git push origin desktop-macos-v0.1.28 --force
git tag -f desktop-linux-v0.1.28 HEAD && git push origin desktop-linux-v0.1.28 --force
git tag -f desktop-windows-v0.1.28 HEAD && git push origin desktop-windows-v0.1.28 --force

# Android APK
git tag -f android-v0.1.28 HEAD && git push origin android-v0.1.28 --force
```

This ensures the checkout ref matches the actual code on `main` with the fix included.

## Notes

- `version:all:*` bumps root + syncs workspace versions and `@getpaseo/*` dependency versions
- `release:prepare` refreshes workspace `node_modules` links to prevent stale types
- `npm run dev:desktop` and `npm run build:desktop` target the Electron desktop package in `packages/desktop`
- If `release:publish` partially fails, re-run it — npm skips already-published versions
- Website Mac download CTA URL derives from `packages/website/package.json` version at build time

## Completion checklist

- [ ] Update `CHANGELOG.md` with user-facing release notes (features, fixes — not refactors)
- [ ] `npm run release:patch` completes successfully
- [ ] GitHub `Desktop Release` workflow for the `v*` tag is green
- [ ] GitHub `Android APK Release` workflow for the same tag is green
- [ ] EAS `release-mobile.yml` workflow for the same tag is green
