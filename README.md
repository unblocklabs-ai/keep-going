# Keep Going

`keep-going` is a native OpenClaw plugin for Slack-first continuation experiments.

Its job is simple:

- let Turn A finish normally
- inspect the completed run after `agent_end`
- if the turn appears unfinished, launch one advisory Turn B on the same session and Slack thread
- let the main agent disagree with the nudge if it is actually done or blocked

## Remote Install

This repo is set up as its own OpenClaw marketplace, so a public remote install is one command:

```bash
openclaw plugins install keep-going --marketplace unblocklabs-ai/keep-going
openclaw plugins enable keep-going
```

Then restart the OpenClaw gateway or process and verify:

```bash
openclaw plugins list --enabled
openclaw plugins inspect keep-going
```

## Local Install

For local iteration:

```bash
git clone https://github.com/unblocklabs-ai/keep-going.git
openclaw plugins install --link ./keep-going
openclaw plugins enable keep-going
```

## Current Scope

Current phase-1 behavior is intentionally narrow:

- Slack only
- top-level sessions only
- skips `heartbeat` and `cron` runs
- skips subagent and spawned-session runs
- uses a cheap heuristic validator
- launches at most one follow-up Turn B per origin run

The validator is advisory, not authoritative. Turn B is instructed to stop immediately if the previous turn was already complete or truly blocked.

## Plugin Config

The plugin exposes a small config surface through `openclaw.plugin.json`:

```json
{
  "enabled": true,
  "channels": ["slack"],
  "timeoutMs": 120000,
  "heuristic": {
    "enabled": true
  }
}
```

## Repository Notes

- `index.ts` registers the native plugin entry
- `src/plugin.ts` wires the `agent_end` hook and launch flow
- `src/validator.ts` contains the phase-1 heuristic
- `src/session-route.ts` recovers Slack routing from session metadata
- `src/launcher.ts` launches the advisory continuation turn
- `plan/` holds the design docs for scope and architecture

## Status

This is an experiment repo, not a polished upstream-ready package yet.

The goal is to answer one question with real usage data:

“Can a post-turn continuation nudge reduce disappointing half-finished async-worker outcomes?”
