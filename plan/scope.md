# Scope

## Problem Definition

OpenClaw agents can end a turn while clearly indicating that more work remains, even when:

- the user gave concrete success criteria
- the agent is not blocked on missing information, permissions, or tool access
- the next action is already known and was often stated by the agent itself

In practice, the failure mode looks like:

- the agent performs a meaningful amount of work
- the agent sends a user-facing message that summarizes progress
- the final message also states a remaining next step such as "Next I need to tighten `skills/daily-pacing-v2/scripts/validate_llm_write_plan.py` ..."
- the turn ends anyway

This is not primarily a planning failure. It is a completion-control failure.

The core issue is that the runtime currently allows a turn to close after a superficially reasonable assistant message, even when the message itself is evidence that the assigned task is still incomplete.

## Why This Matters

For users who operate agents as delegated workers, early turn termination is expensive:

- the user expects the agent to continue until success criteria are met or a real blocker is reached
- the user may not return for many minutes or an hour
- when they do return, the task is only partially complete despite no genuine blocker

This degrades trust in the agent more than latency does. A slightly longer run is acceptable. A prematurely stopped run is usually not.

## Approach

The prototype approach is:

Turn A ends -> plugin inspects -> plugin may start Turn B on the same session

The plugin is a continuation nudge, not the final arbiter of task completion. Turn A is still delivered normally. If the plugin decides a follow-up may be useful, it starts an advisory Turn B. The main agent can still conclude that the task is already complete or truly blocked.

This approach is attractive because it gives:

- no added latency to Turn A
- a local experiment under user control
- direct evaluation data for prompt and runtime changes
- an escape hatch when the continuation signal is wrong
- a close fit for async-worker usage, where the goal is to keep working until done or genuinely blocked

The OpenClaw runtime surface is sufficient for this experiment:

- `agent_end` exists as a plugin hook in `Desktop/unblocked/openclaw/src/plugins/types.ts`
- trusted native plugins can call `api.runtime.agent.runEmbeddedPiAgent(...)`
- subagent lifecycle hooks exist, so the plugin can suppress continuation while a child subagent is still in flight

That means the first prototype does not require a core OpenClaw change. It can be built as a local post-turn continuation layer.

### Phase 1 Outcome

Phase 1 validated the core runtime hypothesis.

What is now proven:

- the `agent_end` hook path is sufficient to inspect completed runs without adding latency to Turn A
- a trusted native plugin can launch an advisory continuation run through `runEmbeddedPiAgent(...)`
- the continuation can stay on the same OpenClaw session and the same Slack thread
- the plugin can recover useful unfinished turns in real usage rather than only in theory

What Phase 1 did not change:

- it did not make Turn A itself longer
- it did not resume the already-finished run
- it did not turn the plugin into the final arbiter of completion truth

The main lesson from Phase 1 is that the architecture is viable. The next problem is validator precision, not whether post-turn continuation is possible at all.

### What This Prototype Tests

The core question is:

"Can a semantic completion nudge reduce disappointing half-finished async-worker outcomes?"

This plugin is intended to answer that directly. It is a better experiment than debating heuristics in the abstract because it produces observable outcomes.

Useful evaluation signals include:

- how often the plugin starts Turn B
- how often Turn B produces meaningful additional work
- how often Turn B immediately concludes the task was already complete
- how often Turn B immediately reports a real blocker
- how often prompt or runtime changes reduce the need for Turn B

### Turn B Contract

Turn B should be advisory rather than coercive.

The continuation run should receive a minimal prompt such as:

- `Continue the previous task.`

The real instruction should live in `extraSystemPrompt`, not in a long synthetic user message. That system instruction should say, in substance:

- a completion validator flagged the previous turn as possibly incomplete
- the validator may be wrong
- if the previous turn was actually complete, say so briefly and stop
- if the agent is truly blocked, state the exact blocker briefly and stop
- otherwise, perform the next remaining actionable step now
- before the first tool call, send a short interim update telling the user the remaining work is being continued

This keeps transcript pollution low while preserving an explicit escape hatch for the agent.

### Same Session, New Run

The continuation mechanism is same-session but not same-run.

That means:

- Turn B is a separate `runEmbeddedPiAgent(...)` invocation
- Turn B reuses the same `sessionId` and `sessionKey`
- Turn B should land in the same Slack thread when session routing is resolved correctly
- Turn A is already over by the time the plugin acts

This distinction matters conceptually. The plugin does not "wake the current turn back up." It starts a new run on the same conversation state after the previous run has ended.

### First Implementation Shape

The initial prototype should have five parts:

1. `agent_end` hook
2. lightweight validator
3. session lookup helper
4. one-shot dedupe state
5. Turn B launcher

The `agent_end` hook should:

- inspect only successful runs
- require a usable session identity
- skip any run that has already been retriggered once
- skip immediate subagent-handoff runs and skip parent sessions that still have an active child subagent

The lightweight validator should:

- start as code-only
- decide whether continuation is warranted
- return a small structured result such as:
  - `continue`
  - `reason`
  - `follow_up_instruction`

The session lookup helper should:

- load the session-store entry for the completed run
- confirm the run resolves to Slack delivery context
- recover routing and thread metadata needed for safe Turn B delivery

The one-shot dedupe state should:

- key on session and originating run identity
- allow at most one Turn B launch per completed Turn A

The Turn B launcher should:

- call `api.runtime.agent.runEmbeddedPiAgent(...)`
- reuse the same session
- preserve model/provider settings where possible
- preserve Slack routing and thread context
- use a minimal prompt plus a richer `extraSystemPrompt`

### Practical Caveat

The `agent_end` context is useful but not exhaustive. It contains enough information for a session-level continuation experiment, especially in local or CLI-style testing, but it is not the same thing as a full reply-target object for polished multi-channel UX.

That is acceptable for this phase. The prototype should be treated as a session-level continuation experiment first, not as a production-complete messaging feature.

### Rollout

The prototype ships in two phases:

1. code-only continuation trigger
2. optional LLM-based validator

Phase 1 detects explicit unfinished language, triggers one advisory Turn B, and collects logs and evaluations. Phase 2 keeps the same post-turn plugin path and swaps in an LLM validator so the two approaches can be compared on precision and usefulness.

Phase 2 should build on the Phase 1 runtime path rather than replacing it. The current plugin wiring is already good enough. The main change should be validator quality.

Phase 2 should not require the phase-1 heuristic as a prerequisite. The LLM validator should be able to act as the primary continuation decision path.

Phase 2 implementation choice:

- the validator calls OpenAI directly with a plugin-scoped API key
- the validator does not create its own OpenClaw run
- only Turn B is user-visible

## Non-Goal

This project is not trying to make the agent think better in general.

It is not:

- a broad prompt-engineering effort
- a replacement for existing cheap heuristics that catch obviously empty planning-only turns
- a general-purpose evaluator of answer quality

The narrow goal is to reduce false-positive turn completion when the agent should still be working.

## Phase 1 Channel Scope

Phase 1 is intentionally Slack-only.

This plugin should not try to be a generic multi-channel continuation layer in the first implementation.

Reasons:

- the current user need is Slack-specific
- Slack thread placement is operationally important
- broad channel support would add routing and delivery complexity before the continuation idea is validated

So the first prototype should only operate when the originating session resolves to Slack delivery context.

## Session Lookup Requirement

Session lookup is in scope from the start.

This is not just for nice-to-have metadata. It is needed for two concrete reasons:

- correctly determine which completed runs are eligible for continuation
- preserve Slack delivery context so a plugin-triggered Turn B does not accidentally post at channel level instead of the originating thread

The plugin should therefore treat session metadata lookup as part of the minimal viable design, not as a later optimization.

## Target Failure Class

This plugin focuses on cases where all of the following are true:

- the assistant ended the turn
- the task is only partially complete
- the assistant's own final message implies unfinished work
- the assistant appears capable of continuing without user intervention

Examples:

- "Next I need to update file X" when updating file X is already within scope
- "I still need to run Y" when Y is an available tool action
- "The remaining step is Z" when Z is exactly the requested deliverable path

## Desired Outcome

When an agent ends a turn, the system should be able to distinguish between:

1. truly finished
2. genuinely blocked
3. prematurely stopped but still able to continue

If the third case is detected, the system should be able to trigger a follow-up run on the same session so the agent can continue the work instead of waiting for the user to wake it back up.

## Local Prototype Constraint

This work is intentionally being prototyped as a local plugin rather than a core OpenClaw change.

That means the initial solution can be:

- post-turn rather than in-turn
- observable and reversible
- instrumented for evaluation

The first version does not need to be elegant. It needs to be testable, measurable, and safe enough to run locally.
