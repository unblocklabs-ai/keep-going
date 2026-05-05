# Release

This plugin is released from one repo version. The release script keeps the GitHub tag/release, npm package, and OpenClaw marketplace install mirror on the same version.

## Marketplace Mirror

For marketplace installs like:

```bash
openclaw plugins install keep-going --marketplace unblocklabs-ai/keep-going
```

OpenClaw resolves the plugin from this repo's marketplace manifest, so a deployable release should keep these files in sync:

- `package.json`
- `package-lock.json`
- `openclaw.plugin.json`
- `.claude-plugin/marketplace.json`
- `marketplace/keep-going/`

`marketplace/keep-going/` is the installable marketplace package mirror. It contains only runtime install files (`package.json`, `openclaw.plugin.json`, `README.md`, and `dist/**`) so OpenClaw's marketplace security scanner does not scan development and release scripts from the repository root.

Refresh it with:

```bash
npm run marketplace:sync
```

## Release Script

Run releases from the repo root:

```bash
npm run release -- patch
```

You can also use:

```bash
npm run release:patch
npm run release:minor
npm run release:major
```

What it does:

- bumps the version in all release metadata files
- runs `npm run preflight`
- emits `dist/index.js`
- refreshes and stages the marketplace package mirror
- stages only release metadata, `dist/`, and `marketplace/keep-going/`
- commits with `release: vX.Y.Z`
- creates an annotated `vX.Y.Z` git tag
- pushes the current `main` branch and tag to `origin`
- publishes `@unblocklabs/openclaw-keep-going@X.Y.Z` to npm when `openclaw.release.publishToNpm` is enabled
- creates a GitHub release for `vX.Y.Z`

Useful flags:

```bash
npm run release -- 0.3.0 --dry-run
npm run release -- patch --message "release: v0.3.0 keep-going wake prompt fix"
npm run release -- patch --no-npm
npm run release -- patch --no-github-release
```

After pushing, OpenClaw installs can pick up the new repo state and existing installs can update with:

```bash
openclaw plugins update keep-going
```
