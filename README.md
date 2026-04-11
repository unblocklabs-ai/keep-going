# Keep Going

`keep-going` is a local OpenClaw plugin scaffold for experimenting with post-turn continuation logic.

## Goal

The intended behavior is:

- an agent finishes turn A
- the plugin inspects the completed turn
- if the work appears unfinished, the plugin can trigger a follow-up run B on the same session
- the main agent can still ignore the nudge if it is actually done or blocked

This is intentionally separate from OpenClaw core so the behavior can be tested locally without waiting on upstream changes.

## Current State

This directory is only a boilerplate native plugin package.

- `package.json` exposes `./index.ts` through `openclaw.extensions`
- `package.json` includes `compat` and `build` metadata for OpenClaw `2026.4.9`
- `openclaw.plugin.json` provides the required native plugin manifest and empty config schema
- `index.ts` registers an empty plugin entry
- no hooks, services, commands, or runtime logic are implemented yet

## Planned Shape

Likely implementation areas for later:

- subscribe to a turn-complete or agent-message-adjacent event
- inspect the final assistant output plus current-turn tool activity
- decide whether the turn is actually complete
- optionally enqueue a follow-up run on the same session
- record metrics so prompt and policy changes can be evaluated

## Notes

This scaffold is aimed at the native OpenClaw plugin system, not the separate Codex `.codex-plugin` format.
