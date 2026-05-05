# Changelog

## 0.3.1 - 2026-05-05

- Fixed validator credential resolution to fall back to shared `OPENAI_API_KEY` when `KEEP_GOING_OPENAI_API_KEY` is not set.
- Kept `KEEP_GOING_OPENAI_API_KEY` as the plugin-specific override when both variables exist.
- Updated README and plugin metadata to document validator credential precedence.

## 0.3.0 - 2026-05-05

- Replaced user-facing Slack continuation notices with an `eyes` reaction on the assistant message.
- Added `continuationReaction.enabled` config.
- Added installable marketplace package mirror under `marketplace/keep-going`.
- Added npm/GitHub release automation and MIT license metadata.
