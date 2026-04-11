# Plugin Internal Constraints

## Purpose

This document summarizes the OpenClaw plugin architecture that matters for `keep-going`.

The goal is not to restate all plugin docs. The goal is to answer four concrete questions:

1. what this plugin can do safely with the documented architecture
2. what it cannot assume
3. which local code surfaces are the real implementation hooks
4. how to avoid over-engineering the first prototype

## Sources Reviewed

External docs:

- `https://docs.openclaw.ai/plugins/architecture`

Relevant local code:

- `Desktop/unblocked/openclaw/src/plugins/types.ts`
- `Desktop/unblocked/openclaw/src/plugins/hooks.ts`
- `Desktop/unblocked/openclaw/src/plugins/runtime/types-core.ts`
- `Desktop/unblocked/openclaw/src/plugins/runtime/types.ts`
- `Desktop/unblocked/openclaw/src/plugins/runtime/runtime-agent.ts`
- `Desktop/unblocked/openclaw/src/agents/pi-embedded-runner/run/attempt.ts`
- `Desktop/unblocked/openclaw/src/agents/pi-embedded-runner/run/params.ts`

Additional SDK reference:

- `https://docs.openclaw.ai/plugins/sdk-runtime#plugin-runtime-helpers`

## Architecture Facts That Matter

### 1. Native plugins are in-process and trusted

The architecture doc is explicit: native OpenClaw plugins run in-process with the gateway and are not sandboxed.

Implications for `keep-going`:

- the plugin can run arbitrary TypeScript logic
- the plugin can maintain local state
- the plugin can call runtime helpers
- a plugin bug can destabilize the gateway, so the prototype should stay small and bounded

This is important because `keep-going` is not trying to be a pure metadata plugin. It is a runtime control-flow plugin.

### 2. Hook-only plugins are still supported

The docs describe hook-only plugins as a supported legacy shape, with a compatibility advisory rather than a hard failure.

Implications for `keep-going`:

- this plugin does not need to register a new capability
- this plugin does not need a tool, route, or command just to prove the continuation idea
- a hook-only first version is architecturally acceptable

This is the right choice for the prototype. Defining a new capability would be premature.

### 3. The manifest is control-plane, runtime module is data-plane

OpenClaw’s loader uses the manifest first for identity, config schema, and enablement. Actual runtime behavior comes later from `register(api)`.

Implications for `keep-going`:

- `openclaw.plugin.json` should stay minimal
- config schema should remain small and focused
- the actual continuation logic belongs in runtime code, not manifest metadata

### 4. Plugins register into a central registry

The docs are clear that plugins do not mutate arbitrary core globals. They register hooks, tools, services, routes, and so on into a central registry. Core consumes the registry later.

Implications for `keep-going`:

- the plugin should use documented registration surfaces only
- the plugin should not reach into random private core state
- the plugin should treat `api.runtime` and typed hooks as the stable boundary

### 5. Narrow SDK imports are the intended contract

The docs explicitly say to avoid the monolithic `openclaw/plugin-sdk` root barrel and prefer focused subpaths.

Implications for `keep-going`:

- continue using `openclaw/plugin-sdk/plugin-entry`
- avoid incidental helper exports unless the docs clearly bless them

### 6. `api.runtime` is the intended host boundary

The runtime-helpers doc is explicit: plugins should use `api.runtime` instead of importing host internals directly.

Implications for `keep-going`:

- use `api.runtime.agent.*` for session/run concerns
- use `api.runtime.logging.*` for structured logs
- use `api.runtime.agent.session.*` if session file or store lookup is needed
- avoid importing OpenClaw host internals directly from unrelated core modules unless there is no documented helper

For this plugin, that means the runtime boundary is not just convenient. It is the correct architectural seam.

## The Two Critical Surfaces For This Plugin

### 1. `agent_end` is the right observation point

Local code confirms:

- `agent_end` is a typed hook in `src/plugins/types.ts`
- the hook runner exposes `runAgentEnd(...)` in `src/plugins/hooks.ts`
- the embedded PI runner triggers it in `src/agents/pi-embedded-runner/run/attempt.ts`

Most important detail: `agent_end` is fire-and-forget.

The runner comment and implementation show:

- Turn A finishes
- `agent_end` is invoked afterward
- OpenClaw does not await it before completing the run
- hook failures are logged and do not fail the run

That is exactly what this prototype needs.

Practical consequences:

- the plugin cannot block or rewrite Turn A after the fact
- the plugin can inspect Turn A without adding latency to Turn A
- any follow-up action must happen as a separate continuation run

### 2. `api.runtime.agent.runEmbeddedPiAgent(...)` is the right continuation launcher

Local runtime types confirm:

- trusted native plugins receive `api.runtime.agent.runEmbeddedPiAgent`
- that helper is exposed from `src/plugins/runtime/types-core.ts`
- it is wired lazily in `src/plugins/runtime/runtime-agent.ts`

This is the correct mechanism for:

- starting a new run programmatically
- staying inside OpenClaw’s normal agent runner
- reusing normal session, tool, hook, and transcript behavior

This is much better than inventing a custom side channel.

### 3. Subagent lifecycle hooks are the right way to know whether a child is still active

Local plugin types confirm:

- `subagent_spawned` and `subagent_ended` are typed hooks in `src/plugins/types.ts`
- those hooks carry `requesterSessionKey`, `childSessionKey`, and run identity context

Implications for `keep-going`:

- the plugin can maintain a small in-memory map of parent session -> active child sessions
- `agent_end` can skip continuation while a child subagent is still in flight
- this should not be inferred from delivery target metadata

Reason:

- delivery target answers "where would a child deliver?"
- it does not answer "is the child still running?"

So for this plugin, lifecycle hooks are the correct signal and delivery target is not.

## Runtime Helpers Worth Using

The runtime-helpers doc adds a few surfaces that are directly useful to this plugin.

### 1. `api.runtime.agent`

This is the most important runtime namespace for `keep-going`.

Useful methods:

- `runEmbeddedPiAgent(...)`
- `resolveAgentTimeoutMs(...)`
- `resolveAgentWorkspaceDir(...)`
- `resolveAgentIdentity(...)`
- `ensureAgentWorkspace(...)`

Why this matters:

- continuation runs should stay on the documented agent runtime path
- timeout and workspace behavior should come from the runtime helper rather than duplicated plugin logic

### 2. `api.runtime.agent.session`

Useful methods:

- `resolveStorePath(...)`
- `loadSessionStore(...)`
- `saveSessionStore(...)`
- `resolveSessionFilePath(...)`

Why this matters:

- if `agent_end` gives us `sessionId` but we need to reconstruct or verify the session file path, there is a documented helper
- if we need session metadata or persistent dedupe, there is a documented session-store seam
- if we need to preserve Slack routing and thread placement for Turn B, session lookup is the right starting point

This does not mean we should add broad persistence now. It means we do not need to invent path logic, and it means session lookup is worth including in phase 1 because delivery context is operationally relevant for Slack.

### 3. `api.runtime.logging`

Useful methods:

- `shouldLogVerbose()`
- `getChildLogger(...)`

Why this matters:

- the plugin should produce structured logs for continuation decisions
- a child logger scoped to `keep-going` makes evals and debugging easier
- logging should use the runtime surface rather than ad hoc `console.log`

### 4. Top-level `api.config`, `api.pluginConfig`, and `api.resolvePath(...)`

The runtime doc also calls out a few non-runtime API fields that matter:

- `api.config` gives the active config snapshot
- `api.pluginConfig` gives plugin-specific config from `plugins.entries.<id>.config`
- `api.resolvePath(...)` resolves paths relative to the plugin root
- `api.registrationMode` indicates whether registration is happening in a lightweight setup window

Why this matters:

- the prototype can read its own config cleanly without inventing a parallel config source
- any plugin-owned local files should resolve through `api.resolvePath(...)`
- we should avoid complicated behavior during lightweight setup windows and keep the real logic in normal runtime registration

## Runtime Helpers We Should Explicitly Not Use First

### 1. `api.runtime.subagent`

The runtime-helpers doc exposes a subagent API, but it is not the right primary tool for this experiment.

Reason:

- the continuation we want is same-session Turn B, not a separate helper session
- subagent semantics imply a different ownership and delivery model
- provider/model overrides on subagents have extra opt-in constraints

For `keep-going`, `runEmbeddedPiAgent(...)` is the cleaner fit.

### 2. `api.runtime.taskFlow`

TaskFlow is useful for managed workflows, waiting states, and controller-style orchestration.

It is not needed for the first prototype because:

- phase 1 needs one post-turn continuation attempt, not a workflow engine
- introducing flow state would add structure before we know the continuation idea is even useful

### 3. `api.runtime.events`

The runtime doc exposes agent-event and transcript-update subscriptions.

That may become useful later for richer observability, but it is not needed for the first version because:

- `agent_end` already gives the core trigger
- transcript subscriptions would add more moving parts without changing the basic continuation decision

### 4. `createPluginRuntimeStore`

The runtime doc suggests `createPluginRuntimeStore` when code outside `register(...)` needs access to the runtime.

That is a useful tool, but we should only adopt it if the plugin grows beyond a small single-runtime structure.

For phase 1:

- if the implementation remains compact, passing dependencies explicitly is simpler
- use a runtime store only if we split logic across modules and the dependency wiring starts getting noisy

## What `agent_end` Actually Gives Us

The local type definitions matter more than vague mental models.

`PluginHookAgentEndEvent` includes:

- `messages`
- `success`
- `error`
- `durationMs`

`PluginHookAgentContext` includes:

- `runId`
- `agentId`
- `sessionKey`
- `sessionId`
- `workspaceDir`
- `modelProviderId`
- `modelId`
- `messageProvider`
- `trigger`
- `channelId`

This is enough for a continuation experiment because the plugin can:

- inspect the completed turn content
- know whether the run succeeded
- know which session and workspace to continue
- preserve provider and model where appropriate

This is not enough for a perfect channel-delivery abstraction by itself.

The hook context does not provide a rich reply-target object. That means the first version should be treated as a session-level continuation experiment, not a polished multi-channel UX system.

However, because the current user need is Slack-specific and the session store carries normalized delivery fields, phase 1 can and should do better than blind best-effort routing by looking up the session entry.

## What `runEmbeddedPiAgent(...)` Actually Requires

`RunEmbeddedPiAgentParams` is large, but the first prototype should use only a small subset.

The critical fields are:

- `sessionId`
- `sessionFile`
- `workspaceDir`
- `prompt`
- `timeoutMs`
- `runId`

Likely also needed:

- `sessionKey`
- `config`
- `provider`
- `model`
- `trigger`
- `messageChannel` or `messageProvider` when preserving routing context helps
- `extraSystemPrompt`

This is an important design constraint:

- we should not try to populate every optional field
- we should carry forward only the fields that materially preserve continuation behavior

The architecture already gives us a full runner. The prototype should not build a fake runner wrapper around it.

## Slack-Specific Phase 1 Focus

Phase 1 should be intentionally Slack-only.

That means:

- only continue runs whose resolved session delivery context is Slack
- preserve Slack thread/channel routing as part of continuation launch
- ignore broader multi-channel generalization for now

This is the right cut because the immediate product risk is confusing Slack thread behavior, not lack of generic channel support.

## What We Can Do

The current architecture supports all of the following:

- register a native plugin that is hook-only
- observe completed runs through `agent_end`
- inspect the full message snapshot provided to `agent_end`
- keep plugin-local in-memory dedupe state
- read session files or session store paths if needed through runtime helpers
- read normalized session delivery metadata from the session store
- start a same-session continuation run through `api.runtime.agent.runEmbeddedPiAgent(...)`
- preserve the originating provider/model as a best-effort default
- preserve Slack routing/thread context as a first-class phase 1 concern
- inject a small advisory `extraSystemPrompt` into Turn B
- collect logs and metrics locally without modifying OpenClaw core

That is enough to answer the actual product question.

## What We Should Not Assume

### 1. The plugin cannot retroactively change Turn A

Because `agent_end` is fire-and-forget and post-run:

- it cannot edit the already-produced assistant message
- it cannot convert Turn A into a longer same-run continuation
- it cannot act as an in-loop arbiter without core changes

The plugin can only launch Turn B.

### 2. The plugin should not depend on undocumented helper seams

The architecture doc explicitly warns against relying on incidental bundled-plugin helper exports.

So `keep-going` should avoid:

- importing private bundled plugin internals
- depending on implementation-detail SDK seams
- reaching into core modules outside documented runtime or hook surfaces unless strictly necessary

### 3. The plugin does not automatically get perfect delivery metadata

For a same-session local experiment, session identity is enough.

For polished multi-channel continuation UX, more delivery-specific state may eventually be needed. That is a later concern. It should not distort the first prototype.

But for Slack specifically, session lookup should be in scope from the start because posting Turn B at channel level instead of in-thread would be actively confusing.

### 4. The plugin should not start as a service, route, or new capability

Nothing in the architecture requires that for this experiment.

Adding any of the following now would be unnecessary:

- a background service
- a custom HTTP route
- a new agent tool
- a CLI command
- a new capability contract in core

Those additions would mostly create maintenance surface without answering the core question faster.

### 5. The plugin should not treat itself as the final arbiter

Architecturally, this plugin is best implemented as a nudge layer, not as a hard stop/go governor.

The healthiest split is:

- plugin decides whether a continuation attempt is worth trying
- agent in Turn B decides whether it is actually done, blocked, or should continue

That matches the actual post-turn architecture much better than trying to force completion truth from the outside.

## Minimal Recommended Internal Design

The first version should be five pieces only:

1. `agent_end` hook registration
2. validator function
3. session lookup helper
4. one-shot dedupe state
5. continuation launcher

Nothing else is required to validate the idea.

### 1. `agent_end` hook

Responsibilities:

- ignore unsuccessful runs at first
- ignore runs without `sessionId`, `sessionKey`, or `workspaceDir`
- ignore runs already retriggered once
- pass the final snapshot into the validator

This hook should stay very thin.

### 2. Validator

Responsibilities:

- inspect the completed assistant turn
- decide whether a continuation attempt is warranted
- produce a structured result:
  - `continue`
  - `reason`
  - `followUpInstruction`

The first validator should be code-only.

Reason:

- lower complexity
- easier debugging
- clearer eval baseline

An LLM validator can be added later behind the same interface.

### 3. Session lookup helper

Responsibilities:

- load the session-store entry for the completed run
- determine whether the run belongs to Slack
- recover normalized delivery context needed for safe continuation routing
- assist with eligibility checks when hook context alone is not enough

For phase 1, this helper should stay read-only and narrowly focused on routing and eligibility.

### 4. One-shot dedupe state

Responsibilities:

- prevent the same Turn A from retriggering multiple Turn B runs
- key on session plus originating run

For the first version, in-memory process-local state is enough.

Reason:

- the experiment is about usefulness, not crash-proof replay semantics
- persistence can be added later if it proves necessary

If persistence becomes necessary later, prefer documented session/state helpers over custom path conventions.

### 5. Continuation launcher

Responsibilities:

- call `api.runtime.agent.runEmbeddedPiAgent(...)`
- reuse the same session
- reuse provider/model where reasonable
- preserve Slack routing and thread context when launching Turn B
- send a minimal prompt
- put the actual continuation policy in `extraSystemPrompt`

This continuation should be advisory:

- if the previous turn was complete, the agent may say so and stop
- if it is blocked, it may state the blocker and stop
- otherwise, it should do the next actionable step

## Over-Engineering Traps To Avoid

### Trap 1: building a new capability

Not needed. Hook-only is sufficient.

### Trap 2: building a generalized workflow engine

Not needed. One post-turn nudge is enough for phase 1.

### Trap 3: persisting complex state immediately

Not needed. Start with one-shot in-memory dedupe.

If persistence becomes necessary later, prefer `api.runtime.agent.session.*` or `api.runtime.state.resolveStateDir()` over hand-rolled storage paths.

### Trap 4: trying to generalize channel UX first

Not needed. Start with Slack-only continuation correctness.

### Trap 5: adding an LLM judge before a code baseline

Not needed. First learn whether explicit unfinished-language nudges are already useful.

## Concrete Plan Implications

Based on the current architecture, the next design document should assume:

- this is a hook-only native plugin
- `agent_end` is the trigger point
- Turn B is a separate same-session run
- Turn B is advisory, not coercive
- the first validator is code-only
- session lookup is part of phase 1
- dedupe is local and one-shot
- phase 1 is intentionally Slack-only
- no new OpenClaw core capability is required
- runtime access should go through `api.runtime`, not direct host internals
- structured plugin logging should be part of the first implementation

That is the smallest architecture that still tests the real product hypothesis.
