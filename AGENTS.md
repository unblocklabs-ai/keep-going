# AGENTS.md

Work from the repository root. Keep changes small, preserve generated/package mirrors, and do not revert user changes.

## Layout

- Source lives in `src/`.
- Built runtime artifacts live in `dist/` and are committed because the plugin package loads them.
- The installable marketplace package lives in `marketplace/keep-going/` and is synced from the root package.
- Release process docs live in `docs/RELEASE.md`; release notes live in `CHANGELOG.md` and GitHub releases.

## Validation

- Use Node 24 for local validation and CI.
- Run `npm test` for focused behavior checks.
- Run `npm run preflight` before release or broad plugin/package changes.
- `npm run preflight` is expected to run build, typecheck, tests, marketplace sync/checks, inspector, pack dry-run, and production audit.
- The inspector may report the known conversation-access privacy-boundary follow-up; do not treat that as a new failure unless the status changes.

## Marketplace Mirror

- Run `npm run marketplace:sync` after README, manifest, package metadata, or built runtime changes.
- Run `npm run marketplace:check` when reviewing whether the installable subdirectory is in sync.
- Do not edit `marketplace/keep-going/` manually unless the sync script cannot represent the intended structure.

## Release

- npm package: `@unblocklabs/openclaw-keep-going`.
- Current release flow is local: `npm run release -- patch|minor|major`.
- Release requires npm publish access and GitHub release access.
- If npm trusted publishing is configured later for `unblocklabs-ai/keep-going`, move npm publishing into GitHub Actions and stop publishing from local machines.
- After release, verify npm, GitHub tag, GitHub release, and a clean working tree.
