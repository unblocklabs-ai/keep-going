![Keep Going banner](https://raw.githubusercontent.com/unblocklabs-ai/keep-going/main/docs/keep-going-banner.webp)

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
- `OPENAI_API_KEY` available to the OpenClaw gateway process, or `KEEP_GOING_OPENAI_API_KEY` when the validator should use a plugin-specific key

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
  "continuationNotice": {
    "mode": "fallbackOnly",
    "text": ":eyes: continuing..."
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
- `continuationReaction.enabled` defaults to `true`; when enabled, the plugin adds an `eyes` reaction to the assistant Slack message only after the validator approves a continuation and the assistant message id is a Slack timestamp
- `continuationNotice.mode` defaults to `fallbackOnly`; if the reaction is skipped or fails, the plugin posts `:eyes: continuing...` in the Slack thread so users can see the continuation fired
- `validator.llm.model` defaults to `gpt-5.4-mini`
- `validator.llm.apiKeyEnv` defaults to `KEEP_GOING_OPENAI_API_KEY`, which overrides the shared `OPENAI_API_KEY` when set
- `OPENAI_API_KEY` is used as the fallback validator credential from OpenClaw config env or process env so normal OpenClaw OpenAI config works without extra plugin setup
- `validator.llm.apiKey` is supported as the highest-priority inline override, but usually not desirable
- `includeCurrentTurnOnly` keeps the validator focused on the current task while still allowing a small amount of recent context
- `debug_logs: true` enables structured step-by-step plugin logging; when `false`, only error logs are emitted

## Runtime Behavior

The plugin includes a few guards to avoid bad continuations:

- plugin-started follow-up runs are tagged and skipped on re-entry
- only top-level Slack sessions are eligible
- the parent turn is skipped while child subagents are still active
- continuation launch is aborted if newer session activity appears during validation
- model, provider, auth profile, and Slack routing are reused from the existing session route

The validator is called directly against OpenAI and does not create its own OpenClaw run. When reaction posting is enabled, the wake marker is a Slack reaction. If the reaction target cannot be confirmed as a Slack message timestamp or Slack rejects the reaction, Keep Going falls back to a short in-thread continuation notice.

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

## Repository Layout

- `index.ts` registers the native plugin entry
- `dist/index.js` is the compiled plugin entry loaded by OpenClaw
- `src/plugin.ts` wires the event hooks, validator call, and continuation launch flow
- `src/llm-validator.ts` builds the transcript window and calls the structured validator response
- `src/session-route.ts` restores Slack routing and auth continuity from session metadata
- `src/launcher.ts` starts the same-session follow-up run

Maintainer release notes live in [`docs/RELEASE.md`](https://github.com/unblocklabs-ai/keep-going/blob/main/docs/RELEASE.md).

## License

MIT
