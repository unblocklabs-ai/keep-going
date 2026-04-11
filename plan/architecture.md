# Architecture

## Goal

Build a hook-only native OpenClaw plugin that detects likely premature turn completion and can launch one advisory same-session continuation run.

The architectural target is intentionally narrow:

- no core OpenClaw changes
- no added latency to Turn A
- no new capability contract
- no service, route, or tool in phase 1
- Slack-only in phase 1
- one post-turn continuation attempt at most
- session lookup included from the start

## System Shape

The first version should have one wiring component and five implementation pieces.

Wiring component:

1. plugin entry

Implementation pieces:

2. `agent_end` hook handler
3. continuation validator
4. session lookup helper
5. one-shot dedupe state
6. continuation launcher

## Component Breakdown

### 1. Plugin entry

Responsibilities:

- register the plugin with `definePluginEntry(...)`
- read plugin config
- create scoped logger
- initialize in-memory dedupe state
- register the `agent_end` hook

This module should stay thin. It should wire dependencies, not contain decision logic.

### 2. `agent_end` hook handler

Responsibilities:

- receive completed run event and context
- apply cheap early exit checks
- invoke the validator
- if continuation is warranted, invoke the launcher

This is the orchestration boundary.

Early exit checks should include:

- event was not successful
- missing `runId`
- missing `sessionId`
- missing `sessionKey`
- missing `workspaceDir`
- `trigger` is `heartbeat` or `cron`
- session is a subagent session
- already retriggered for this originating run
- plugin config disables continuation

The handler should be defensive. It runs in-process and fire-and-forget, so it must fail closed rather than destabilizing the gateway.

### 3. Continuation validator

Responsibilities:

- analyze the final run snapshot
- decide whether a continuation attempt is justified
- produce a small structured result

Phase 1 validator type:

- deterministic code-only heuristic

Phase 2 validator type:

- optional LLM-based semantic validator behind the same interface

The validator should not launch anything directly. It only returns a decision.

### 4. Session lookup helper

Responsibilities:

- load the relevant session-store entry
- recover normalized delivery context
- confirm the run belongs to Slack
- help determine whether the run is a top-level eligible session

Phase 1 implementation:

- read-only lookup through documented session runtime helpers

This helper exists because `agent_end` context is not enough by itself to guarantee safe Slack continuation routing.

### 5. One-shot dedupe state

Responsibilities:

- prevent repeated continuation launches for the same completed run
- avoid local continuation storms

Phase 1 implementation:

- process-local in-memory set or map

Keying:

- `sessionKey + runId`

Optional metadata:

- timestamp
- validator reason
- launched follow-up run id if available

This state should be small and self-pruning if retained for longer than one process tick.

### 6. Continuation launcher

Responsibilities:

- construct Turn B parameters
- call `api.runtime.agent.runEmbeddedPiAgent(...)`
- log the launch outcome

The launcher should reuse:

- the same session
- the same workspace
- the same provider/model when available

The launcher should inject:

- a short prompt
- a richer `extraSystemPrompt`

The launcher should also preserve Slack routing and thread context, based on resolved session metadata, so a continuation run does not accidentally post at channel level.

The launcher should not attempt to mutate Turn A output or splice itself into the same run. Its job is only to start Turn B.

## Primary Flow

### Turn A completion path

1. OpenClaw finishes Turn A.
2. OpenClaw fires `agent_end` in fire-and-forget mode.
3. `keep-going` receives the event and context.
4. The hook handler runs cheap eligibility checks.
5. If eligible, the validator inspects the event snapshot.
6. If validator says `continue = false`, the hook exits.
7. If validator says `continue = true`, the hook records dedupe state.
8. The launcher starts Turn B on the same session.
9. Turn B decides whether to:
   - stop as already complete
   - stop as blocked
   - continue with the next actionable step

## Eligibility Rule

Phase 1 should only run for top-level non-background, non-subagent runs.

That means:

- exclude `trigger = "heartbeat"`
- exclude `trigger = "cron"`
- exclude subagent sessions
- exclude non-Slack sessions after session lookup

It does not mean "only the literal main session".

Why:

- top-level user work can live on many normal session keys, not just `agent:main:main`
- channel- or peer-scoped top-level sessions are still legitimate candidates
- the real exclusion target is subagent ancestry, not session-key equality with `main`

So the intended filter is:

- allow top-level sessions for the main agent
- reject sessions that are subagent sessions
- reject background heartbeat and cron runs
- require Slack delivery context

### Subagent detection

`agent_end` gives `trigger`, but not `spawnedBy`.

So the implementation should not try to infer subagents from `trigger`.

Preferred phase 1 check:

- use the canonical session-key helper such as `isSubagentSessionKey(sessionKey)`

Fallback if needed later:

- consult session metadata or stored `spawnedBy`

For phase 1, session-key-based detection is the correct low-complexity choice, but it should be combined with session-store lookup so routing and Slack scope are also validated.

### Slack-only scope

Phase 1 should only continue sessions that resolve to Slack delivery context.

Reason:

- the current user need is Slack-specific
- Slack thread placement matters for clarity
- generic channel support would expand the surface area before the continuation mechanism itself is validated

## Turn B Contract

Turn B is advisory, not coercive.

### Turn B prompt

Minimal user-style prompt:

- `Continue the previous task.`

### Turn B `extraSystemPrompt`

The richer instruction should communicate:

- the previous turn was flagged as possibly incomplete
- the continuation signal may be wrong
- if the previous turn was actually complete, say so briefly and stop
- if truly blocked, state the exact blocker briefly and stop
- otherwise, perform the next remaining actionable step now
- before the first tool call, send a brief interim update that the remaining work is being continued

This split keeps transcript pollution low while preserving explicit behavioral guidance.

## Data Contracts

### Validator input

The validator should receive one compact object, not raw OpenClaw runtime dependencies.

Suggested shape:

```ts
type ContinuationCandidate = {
  runId: string;
  sessionId: string;
  sessionKey: string;
  workspaceDir: string;
  modelProviderId?: string;
  modelId?: string;
  trigger?: string;
  channelId?: string;
  messageProvider?: string;
  success: boolean;
  error?: string;
  durationMs?: number;
  messages: unknown[];
};
```

### Validator output

Suggested phase 1 result:

```ts
type ContinuationDecision = {
  continue: boolean;
  reason: string;
  followUpInstruction?: string;
};
```

This should stay small. The decision object is for orchestration and logging, not for general workflow modeling.

### Launcher input

Suggested launcher input:

```ts
type LaunchContinuationParams = {
  candidate: ContinuationCandidate;
  decision: ContinuationDecision;
  sessionRoute: ResolvedSessionRoute;
  config: OpenClawConfig;
  timeoutMs: number;
};
```

### Session route lookup

The plugin should resolve one compact routing object from session storage before launch.

Suggested shape:

```ts
type ResolvedSessionRoute = {
  channel: "slack";
  to?: string;
  accountId?: string;
  threadId?: string;
  isSlack: boolean;
};
```

The helper should prefer normalized session-store delivery context over ad hoc reconstruction.

## Validator Design

### Phase 1: code-only heuristic

The first validator should target explicit unfinished-language patterns and obvious non-completion signals.

Examples of useful signals:

- final assistant text includes "next I need to"
- final assistant text includes "still need to"
- final assistant text includes "remaining step"
- final assistant text includes "I need to update"
- final assistant text includes "I still need to run"

Negative signals that should suppress continuation:

- assistant explicitly says work is complete
- assistant explicitly says it is blocked and names the blocker
- event indicates run failure
- no assistant-visible text can be extracted

The phase 1 validator should be intentionally conservative. False negatives are acceptable early. False-positive continuation spam is not.

### Phase 2: optional LLM validator

The phase 2 validator should implement the same interface as phase 1, but use an LLM to decide whether Turn B should run.

That second validator should be introduced only after:

- phase 1 logs are in place
- baseline precision is understood
- there is evidence that heuristic detection misses too many useful continuation cases

## Message Extraction Strategy

The `agent_end` event gives `messages: unknown[]`, not a typed assistant summary.

So the plugin should include a narrow extractor utility whose only job is:

- identify the last assistant-visible message or messages
- flatten text content into a string suitable for heuristic inspection

That extractor should be deliberately narrow and local to this plugin. It does not need to become a general transcript parser.

## Configuration

Phase 1 config should stay minimal.

Suggested config shape:

```json
{
  "enabled": true,
  "channels": ["slack"],
  "timeoutMs": 600000,
  "heuristic": {
    "enabled": true
  }
}
```

Suggested defaults:

- `enabled: true`
- `channels: ["slack"]`
- `timeoutMs: use api.runtime.agent.resolveAgentTimeoutMs(api.config)`
- `heuristic.enabled: true`

Phase 1 should not expose many tuning knobs. The plugin needs observability first, not a large config matrix.

## Logging And Evaluation

The plugin should use a scoped structured logger from `api.runtime.logging.getChildLogger(...)`.

At minimum, log these decision points:

- `agent_end` received
- candidate rejected by eligibility checks
- candidate rejected by validator
- continuation launched
- continuation launch failed

Useful log fields:

- plugin id
- source run id
- session key
- provider/model
- resolved channel
- resolved Slack thread id when present
- validator reason
- follow-up run id when available

These logs are the minimum basis for later evaluation.

## Failure Handling

### Validator failure

If validation throws:

- log the failure
- do not launch Turn B

### Launcher failure

If launch throws:

- log the failure
- keep Turn A intact
- do not retry automatically in phase 1

### Duplicate trigger race

If multiple triggers somehow compete:

- first successful dedupe write wins
- later attempts should exit silently or with debug logging

## Session And Delivery Posture

Phase 1 is a session-level continuation design.

That means:

- same `sessionId`
- same `sessionKey`
- same workspace
- same model/provider when possible
- only top-level non-subagent sessions
- no heartbeat or cron runs
- Slack-only routing in phase 1
- session-store-assisted thread preservation

It does not promise:

- perfect channel-specific delivery restoration
- sophisticated thread-rebinding logic
- multi-channel continuation UX polish

That is acceptable because the core hypothesis is about completion quality, not delivery UX completeness.

## Why This Is The Smallest Correct Design

This design is intentionally minimal because the architecture already gives us the hard parts:

- a post-run hook
- a trusted runtime boundary
- a documented embedded-run launcher
- session helpers
- structured logging

So the plugin only needs to supply:

- a continuation decision
- session route lookup
- one-shot dedupe
- a careful Turn B prompt contract

Anything larger in phase 1 would mostly be framework, not product learning.

## Phase Plan

### Phase 1

- hook-only plugin
- code-only validator
- session-store route lookup
- in-memory dedupe
- one advisory Turn B
- Slack-only continuation routing
- structured logs

### Phase 2

- optional LLM validator implementation
- compare against phase 1 precision/usefulness
- add better extraction or session metadata only if logs prove necessary

### Later, only if justified

- persistence for dedupe state
- richer delivery preservation
- upstream proposal for an in-run completion validator in OpenClaw core

## Open Questions

These do not block implementation, but they should be tracked:

1. How reliably can final assistant-visible text be extracted from `agent_end.messages` across providers?
2. Should unsuccessful runs ever trigger Turn B when the failure is recoverable rather than terminal?
3. Do we want a strict allow-list of triggers, such as only `trigger = "user"` at first?
4. Should Turn B reuse the original timeout in full, or a shorter plugin-specific timeout?
5. Do we need a visible marker in logs or transcript to distinguish plugin-started continuation runs from normal user-started runs?
