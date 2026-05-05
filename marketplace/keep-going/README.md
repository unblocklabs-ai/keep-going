![Keep Going banner](https://raw.githubusercontent.com/unblocklabs-ai/keep-going/main/docs/keep-going-banner.jpg)

# Keep Going

`keep-going` is a native OpenClaw plugin that watches completed Slack turns and starts one same-session follow-up run when an LLM validator believes the assistant stopped before the task was actually done.

The plugin is intentionally narrow:

- Slack sessions only
- one follow-up run per completed turn
- no resume-in-place mutation of the original run
- no continuation for heartbeat, cron, subagent, or spawned-session runs

## How It Works

The runtime flow is:

1. Turn A completes normally.
2. The plugin receives `agent_end`.
3. The plugin reconstructs the session route and recent transcript window.
4. The validator decides whether the assistant still owns remaining work.
5. If yes, the plugin starts Turn B on the same session and Slack thread.

Turn B is advisory. It is explicitly told to stop immediately if the previous turn was already complete or truly blocked.

## Install

Prerequisites:

- OpenClaw `2026.5.3` or newer
- `KEEP_GOING_OPENAI_API_KEY` available to the OpenClaw gateway process, unless `validator.llm.apiKey` is configured directly

Remote install:

```bash
openclaw plugins install keep-going --marketplace unblocklabs-ai/keep-going
openclaw plugins enable keep-going
```

Local iteration:

```bash
git clone https://github.com/unblocklabs-ai/keep-going.git
cd keep-going
npm install
npm run build
cd ..
openclaw plugins install --link ./keep-going
openclaw plugins enable keep-going
```

Then restart the gateway and verify:

```bash
openclaw plugins list --enabled
openclaw plugins inspect keep-going
```

## Config

The plugin exposes a small config surface through `openclaw.plugin.json`:

```json
{
  "enabled": true,
  "debug_logs": false,
  "channels": ["slack"],
  "timeoutMs": 120000,
  "continuationReaction": {
    "enabled": true
  },
  "validator": {
    "llm": {
      "model": "gpt-5.4-mini",
      "systemPrompt": "Optional override for the built-in continuation validator prompt.",
      "apiKeyEnv": "KEEP_GOING_OPENAI_API_KEY",
      "maxMessages": 10,
      "maxChars": 20000,
      "includeCurrentTurnOnly": true,
      "recentUserMessages": 3,
      "temperature": 0.2,
      "timeoutMs": 15000
    }
  }
}
```

Notes:

- `enabled` defaults to `true`
- `channels` defaults to `["slack"]`; other channels are ignored
- `continuationReaction.enabled` defaults to `true`; when enabled, the plugin adds an `eyes` reaction to the assistant Slack message only after the validator approves a continuation
- `validator.llm.model` defaults to `gpt-5.4-mini`
- `validator.llm.apiKeyEnv` is the normal way to provide credentials
- `validator.llm.apiKey` is supported but usually not desirable
- `includeCurrentTurnOnly` keeps the validator focused on the current task while still allowing a small amount of recent context
- `debug_logs: true` enables structured step-by-step plugin logging; when `false`, only error logs are emitted

## Runtime Behavior

The plugin includes a few guards to avoid bad continuations:

- plugin-started follow-up runs are tagged and skipped on re-entry
- only top-level Slack sessions are eligible
- the parent turn is skipped while child subagents are still active
- continuation launch is aborted if newer session activity appears during validation
- model, provider, auth profile, and Slack routing are reused from the existing session route

The validator is called directly against OpenAI and does not create its own OpenClaw run. When reaction posting is enabled, the wake marker is a Slack reaction rather than an extra thread message.

## Development

Run the plugin tests with:

```bash
npm test
```

Run the local plugin preflight with:

```bash
npm run preflight
```

The preflight follows the same narrow check shape as OpenClaw's Kitchen Sink fixture: runtime checks, plugin-inspector package inspection, install-shape checks, package dry-run, and runtime dependency audit. Set `OPENCLAW_CHECKOUT=/path/to/openclaw` to force inspector compatibility checks against a specific local OpenClaw checkout. The inspector step fails if no checkout is available unless `CHECK_INSPECTOR_ALLOW_NO_OPENCLAW=1` is set.

## Release

This plugin is released from one repo version. The release script keeps the GitHub tag/release, npm package, and OpenClaw marketplace install mirror on the same version.

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

`marketplace/keep-going/` is the installable marketplace package mirror. It contains only runtime install files (`package.json`, `openclaw.plugin.json`, `README.md`, and `dist/**`) so OpenClaw's marketplace security scanner does not scan development and release scripts from the repository root. Refresh it with:

```bash
npm run marketplace:sync
```

Use the release script from the repo root:

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

## Repository Layout

- `index.ts` registers the native plugin entry
- `dist/index.js` is the compiled plugin entry loaded by OpenClaw
- `src/plugin.ts` wires the event hooks, validator call, and continuation launch flow
- `src/llm-validator.ts` builds the transcript window and calls the structured validator response
- `src/session-route.ts` restores Slack routing and auth continuity from session metadata
- `src/launcher.ts` starts the same-session follow-up run

## License

MIT
