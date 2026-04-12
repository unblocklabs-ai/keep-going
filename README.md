# Keep Going

`keep-going` is a native OpenClaw plugin for Slack-first continuation experiments.

Its job is simple:

- let Turn A finish normally
- inspect the completed run after `agent_end`
- if the LLM validator thinks the turn appears unfinished, launch one advisory Turn B on the same session and Slack thread
- let the main agent disagree with the nudge if it is actually done or blocked

## How It Works

`keep-going` is post-turn, not in-turn.

The flow is:

- Turn A ends normally
- the plugin receives `agent_end`
- the plugin inspects the completed run
- if the validator thinks the turn may be unfinished, the plugin starts Turn B
- Turn B is a new run on the same OpenClaw session and the same Slack thread

This is important:

- it does not resume the already-ended run
- it does not mutate Turn A after the fact
- it does not create a brand-new unrelated user session

The correct mental model is:

- same session
- new run

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

Current behavior is intentionally narrow:

- Slack only
- top-level sessions only
- skips `heartbeat` and `cron` runs
- skips while a child subagent is still in flight for the parent session
- skips subagent and spawned-session runs
- uses a direct OpenAI LLM validator for continuation decisions
- launches at most one follow-up Turn B per origin run

Operational details:

- plugin-started continuation runs are tagged and skipped on re-entry to avoid loops
- in-memory dedupe is pruned over time and replaced per Slack thread
- active child subagents are tracked from live `subagent_spawned` and `subagent_ended` hooks
- continuation launch aborts only if a newer user/assistant message appeared or another run started while validation was in progress
- the continuation launcher reads routing, model, provider, and auth continuity from session metadata

Tracker scope:

- activity tracking is intentionally process-lifetime, not persistent state
- on a gateway restart, those in-memory guards reset with the process
- that is acceptable for this plugin because active agent runs also terminate with the gateway process

The validator is advisory, not authoritative. Turn B is instructed to stop immediately if the previous turn was already complete or truly blocked.

## LLM Validator

The plugin uses a direct OpenAI validator.

Important properties of this path:

- the validator itself does not use `runEmbeddedPiAgent(...)`
- the validator calls OpenAI directly, so it does not create a new OpenClaw run or session
- Turn B remains the only user-visible continuation run

The validator config is plugin-local and model-swappable so judge evals are easy:

```json
{
  "validator": {
    "llm": {
      "model": "gpt-5.4-mini",
      "systemPrompt": "Override only if you want to replace the built-in validator prompt.",
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

Recommended setup:

- set `KEEP_GOING_OPENAI_API_KEY` in the gateway environment
- keep `apiKeyEnv` in plugin config
- swap `validator.llm.model` when comparing `gpt-5.4-mini`, `gpt-5.4-nano`, or later models

The validator uses a capped recent transcript window from the completed run:

- `maxMessages` limits how many transcript messages are considered
- `maxChars` caps the rendered prompt size
- `includeCurrentTurnOnly: true` narrows the window to the last user turn when possible
- `systemPrompt` defaults to the built-in validator prompt and can be overridden without code changes

## Troubleshooting

If the plugin logs `keep-going continuation launch failed`, check the main gateway log first. Plugin logs are emitted inline with the gateway log stream.

Common failure classes:

- wrong model/auth continuity
- missing Slack routing metadata
- plugin not enabled
- session was ineligible because it was a heartbeat, cron run, subagent session, or non-Slack session

For OpenAI Codex OAuth specifically, the continuation must reuse the session's persisted `openai-codex` model/auth state. If it falls back to plain `openai`, the gateway will ask for `OPENAI_API_KEY` and Turn B will fail before any user-visible reply.

## Plugin Config

The plugin exposes a small config surface through `openclaw.plugin.json`:

```json
{
  "enabled": true,
  "channels": ["slack"],
  "timeoutMs": 120000,
  "validator": {
    "llm": {
      "model": "gpt-5.4-mini",
      "systemPrompt": "Default validator prompt string omitted here for brevity; override this to customize continuation judgment behavior.",
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

- inline `validator.llm.apiKey` is supported, but `apiKeyEnv` is the cleaner default
- `validator.llm.systemPrompt` lets you override the validator system prompt; if omitted, the built-in prompt is used
- `validator.llm.recentUserMessages` controls how many recent user turns are kept when `includeCurrentTurnOnly` is true

## Repository Notes

- `index.ts` registers the native plugin entry
- `src/plugin.ts` wires the `agent_end` hook and launch flow
- `src/session-route.ts` recovers Slack routing from session metadata
- `src/launcher.ts` launches the advisory continuation turn
- `plan/` holds the design docs for scope and architecture

## Status

This is an experiment repo, not a polished upstream-ready package yet.

The goal is to answer one question with real usage data:

“Can a post-turn continuation nudge reduce disappointing half-finished async-worker outcomes?”

Phase 1 answer was yes: the post-turn same-session continuation architecture works in practice.

The continuation decision path is now LLM-only without changing the Turn B runtime path.

## Local Validator Eval

For quick local judge evals against a real transcript fixture:

1. Copy `.env.example` to `.env`
2. set `KEEP_GOING_OPENAI_API_KEY`
3. optionally set `KEEP_GOING_VALIDATOR_MODEL`
4. run:

```bash
npm run eval:validator -- --file 42c136e7-6ba6-42e3-afd1-485aa6a99832-topic-1775879458.009949.jsonl --run latest --print-prompt
```

Notes:

- the eval runner reads `.env` locally
- it splits a JSONL transcript into completed run segments using `openclaw:bootstrap-context:full`
- `--run latest` is the default
- the output is a compact JSON decision plus an optional prompt preview
