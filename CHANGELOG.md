# Changelog

## 0.3.3 - 2026-05-05

- Added `validator.llm.apiKeyRef` support for OpenClaw SecretRef-backed validator API keys.
- Preserved existing inline `apiKey`, `apiKeyEnv`, shared OpenAI config, and `OPENAI_API_KEY` fallback behavior.
- Added clear SecretRef resolution warnings that include the config path and ref metadata without logging secret values.

## 0.3.1 - 2026-05-05

- Fixed validator credential resolution to fall back to shared `OPENAI_API_KEY` when `KEEP_GOING_OPENAI_API_KEY` is not set.
- Kept `KEEP_GOING_OPENAI_API_KEY` as the plugin-specific override when both variables exist.
- Updated README and plugin metadata to document validator credential precedence.

## 0.3.0 - 2026-05-05

- Replaced user-facing Slack continuation notices with an `eyes` reaction on the assistant message.
- Added `continuationReaction.enabled` config.
- Added installable marketplace package mirror under `marketplace/keep-going`.
- Added npm/GitHub release automation and MIT license metadata.
