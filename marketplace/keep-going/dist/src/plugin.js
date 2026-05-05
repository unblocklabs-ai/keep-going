import { ActiveSubagentTracker } from "./active-subagents.js";
import { CONTINUATION_REACTION_EMOJI, resolveKeepGoingConfig } from "./config.js";
import { KEEP_GOING_FOLLOW_UP_RUN_ID_PREFIX } from "./constants.js";
import { OneShotDedupe } from "./dedupe.js";
import { launchContinuation, resolveContinuationSessionFile } from "./launcher.js";
import { validateContinuationWithLlm } from "./llm-validator.js";
import { createKeepGoingLogger } from "./logging.js";
import { lastAssistantHasSubagentSpawnToolCall } from "./messages.js";
import { SessionActivityTracker } from "./session-activity.js";
import { isSubagentSessionKey, resolveSessionRoute } from "./session-route.js";
import { addSlackReaction } from "./slack-reaction.js";
const DEFAULT_DEPS = {
    validateContinuationWithLlm,
    launchContinuation,
    addSlackReaction,
};
function normalizeTimeoutMs(api, configuredTimeoutMs) {
    return api.runtime.agent.resolveAgentTimeoutMs({
        cfg: api.config,
        overrideMs: configuredTimeoutMs,
    });
}
function buildCandidate(event, ctx, config) {
    if (!ctx.runId || !ctx.sessionId || !ctx.sessionKey || !ctx.workspaceDir) {
        return undefined;
    }
    return {
        runId: ctx.runId,
        agentId: ctx.agentId,
        sessionId: ctx.sessionId,
        sessionKey: ctx.sessionKey,
        workspaceDir: ctx.workspaceDir,
        modelProviderId: ctx.modelProviderId,
        modelId: ctx.modelId,
        trigger: ctx.trigger,
        channelId: ctx.channelId,
        messageProvider: ctx.messageProvider,
        success: event.success,
        error: event.error,
        durationMs: event.durationMs,
        messages: event.messages,
    };
}
function logSkip(logger, reason, metadata) {
    logger.step(`skip: ${reason}`, metadata);
}
function getMessageRole(message) {
    if (!message || typeof message !== "object") {
        return undefined;
    }
    const role = message.role;
    return typeof role === "string" ? role : undefined;
}
function isResolvedSessionRoute(route) {
    return route.lookupStatus === "ok";
}
function getCandidateSkip(candidate, activeSubagents) {
    if (!candidate.success) {
        return {
            reason: "unsuccessful run",
            metadata: { runId: candidate.runId },
        };
    }
    if (lastAssistantHasSubagentSpawnToolCall(candidate.messages)) {
        return {
            reason: "subagent handoff run",
            metadata: {
                runId: candidate.runId,
                sessionKey: candidate.sessionKey,
            },
        };
    }
    if (activeSubagents.hasActiveChildren(candidate.sessionKey)) {
        return {
            reason: "subagent still in flight",
            metadata: {
                runId: candidate.runId,
                sessionKey: candidate.sessionKey,
                activeChildSessionKeys: activeSubagents.getActiveChildSessionKeys(candidate.sessionKey),
            },
        };
    }
    if (candidate.runId.startsWith(KEEP_GOING_FOLLOW_UP_RUN_ID_PREFIX)) {
        return {
            reason: "plugin-started continuation run",
            metadata: { runId: candidate.runId },
        };
    }
    if (candidate.trigger === "heartbeat" || candidate.trigger === "cron") {
        return {
            reason: "background trigger",
            metadata: {
                runId: candidate.runId,
                trigger: candidate.trigger,
            },
        };
    }
    if (isSubagentSessionKey(candidate.sessionKey)) {
        return {
            reason: "subagent session key",
            metadata: {
                runId: candidate.runId,
                sessionKey: candidate.sessionKey,
            },
        };
    }
    return undefined;
}
function getRouteSkip(candidate, config, route) {
    if (!route.isSlack || !config.channels.includes("slack")) {
        return {
            reason: "non-slack session",
            metadata: {
                runId: candidate.runId,
                channel: route.channel,
            },
        };
    }
    if (route.spawnedBy) {
        return {
            reason: "spawned session",
            metadata: {
                runId: candidate.runId,
                sessionKey: candidate.sessionKey,
                spawnedBy: route.spawnedBy,
            },
        };
    }
    return undefined;
}
function resolveEligibleContinuationContext(runtime, event, ctx, runStartBarrier) {
    const { api, config, logger, dedupe, activeSubagents, sessionActivity } = runtime;
    const candidate = buildCandidate(event, ctx, config);
    if (!candidate) {
        logSkip(logger, "missing candidate context");
        return undefined;
    }
    const candidateSkip = getCandidateSkip(candidate, activeSubagents);
    if (candidateSkip) {
        logSkip(logger, candidateSkip.reason, candidateSkip.metadata);
        return undefined;
    }
    const route = resolveSessionRoute(api, {
        agentId: ctx.agentId,
        sessionKey: candidate.sessionKey,
    });
    logger.step("resolved session route", {
        runId: candidate.runId,
        sessionKey: candidate.sessionKey,
        lookupStatus: route.lookupStatus,
        isSlack: route.isSlack,
        channel: route.channel,
        threadId: route.threadId,
        spawnedBy: route.spawnedBy,
    });
    if (route.lookupStatus === "error") {
        logger.error("session lookup failed", {
            runId: candidate.runId,
            sessionKey: candidate.sessionKey,
            error: route.error,
        });
        return undefined;
    }
    if (route.lookupStatus === "missing-entry") {
        logSkip(logger, "session entry missing", {
            runId: candidate.runId,
            sessionKey: candidate.sessionKey,
        });
        return undefined;
    }
    if (!isResolvedSessionRoute(route)) {
        return undefined;
    }
    const routeSkip = getRouteSkip(candidate, config, route);
    if (routeSkip) {
        logSkip(logger, routeSkip.reason, routeSkip.metadata);
        return undefined;
    }
    const sessionFile = resolveContinuationSessionFile(api, {
        candidate,
        sessionRoute: route,
    });
    const wakeContext = {
        currentMessageId: sessionActivity.getLatestUserMessageId({
            sessionKey: candidate.sessionKey,
            sessionFile,
        }),
        currentChannelId: route.currentChannelId,
        currentThreadTs: route.threadId,
        replyToMode: route.replyToMode,
    };
    const reactionMessageId = sessionActivity.getLatestAssistantMessageId({
        sessionKey: candidate.sessionKey,
        sessionFile,
    });
    const transcriptSnapshot = sessionActivity.captureSnapshot({
        sessionKey: candidate.sessionKey,
        sessionFile,
    });
    const dedupeKey = dedupe.makeKey({
        sessionKey: candidate.sessionKey,
        runId: candidate.runId,
    });
    logger.step("prepared continuation context", {
        runId: candidate.runId,
        sessionKey: candidate.sessionKey,
        sessionFile,
        dedupeKey,
        threadId: route.threadId,
        currentMessageId: wakeContext.currentMessageId,
        reactionMessageId,
        currentChannelId: wakeContext.currentChannelId,
        replyToMode: wakeContext.replyToMode,
    });
    if (dedupe.has(dedupeKey)) {
        logSkip(logger, "already retriggered", {
            runId: candidate.runId,
            sessionKey: candidate.sessionKey,
        });
        return undefined;
    }
    return {
        candidate,
        dedupeKey,
        route,
        wakeContext,
        sessionFile,
        transcriptSnapshot,
        runStartBarrier,
        reactionMessageId,
    };
}
async function evaluateDecision(runtime, candidate) {
    const { config, logger, sessionActivity, deps } = runtime;
    const runTranscriptMessages = sessionActivity.getRunTranscriptMessages(candidate.runId);
    const sessionTranscriptMessages = sessionActivity.getSessionTranscriptMessages(candidate.sessionKey);
    logger.step("starting validator", {
        runId: candidate.runId,
        sessionKey: candidate.sessionKey,
        validatorModel: config.validator.llm.model,
        runTranscriptMessageCount: runTranscriptMessages.length,
        sessionTranscriptMessageCount: sessionTranscriptMessages.length,
    });
    try {
        const decision = await deps.validateContinuationWithLlm({
            candidate,
            config: config.validator.llm,
            context: {
                runTranscriptMessages,
                sessionTranscriptMessages,
            },
            logger,
        });
        logger.step("validator completed", {
            runId: candidate.runId,
            sessionKey: candidate.sessionKey,
            continue: decision.continue,
            reason: decision.reason,
            hasFollowUpInstruction: Boolean(decision.followUpInstruction),
            validatorModel: decision.validatorModel,
        });
        return {
            decision,
            validatorModel: decision.validatorModel,
        };
    }
    catch (error) {
        logger.error("llm validator failed", {
            runId: candidate.runId,
            sessionKey: candidate.sessionKey,
            model: config.validator.llm.model,
            error: error instanceof Error ? error.message : String(error),
        });
        return undefined;
    }
}
function shouldAbortBeforeLaunch(runtime, context, evaluated) {
    const { logger, sessionActivity } = runtime;
    const { candidate, route, sessionFile, transcriptSnapshot, runStartBarrier } = context;
    const { decision, validatorModel } = evaluated;
    if (!decision.continue) {
        logSkip(logger, "validator declined", {
            runId: candidate.runId,
            reason: decision.reason,
            ...(validatorModel ? { validatorModel } : {}),
        });
        return true;
    }
    const newerRuns = sessionActivity.getRunsStartedAfter({
        sessionKey: candidate.sessionKey,
        after: runStartBarrier,
        ignoreRunIds: [candidate.runId],
    });
    if (newerRuns.length > 0) {
        logSkip(logger, "session became active again", {
            runId: candidate.runId,
            candidateRunId: candidate.runId,
            sessionKey: candidate.sessionKey,
            runStartBarrier,
            newerRuns,
        });
        return true;
    }
    if (sessionActivity.hasTranscriptChanged(transcriptSnapshot, {
        sessionKey: candidate.sessionKey,
        sessionFile,
    })) {
        logSkip(logger, "transcript changed before continuation launch", {
            runId: candidate.runId,
            sessionKey: candidate.sessionKey,
            threadId: route.threadId,
        });
        return true;
    }
    return false;
}
async function sendContinuationReaction(runtime, context) {
    const { api, config, logger } = runtime;
    const { candidate, route, reactionMessageId } = context;
    if (!config.continuationReaction.enabled) {
        return;
    }
    if (!route.currentChannelId || !reactionMessageId) {
        logger.error("continuation reaction skipped: missing Slack message route", {
            runId: candidate.runId,
            sessionKey: candidate.sessionKey,
            threadId: route.threadId,
            currentChannelId: route.currentChannelId,
            reactionMessageId,
        });
        return;
    }
    try {
        await runtime.deps.addSlackReaction(api, {
            channelId: route.currentChannelId,
            messageId: reactionMessageId,
            emoji: CONTINUATION_REACTION_EMOJI,
            accountId: route.accountId,
        });
        logger.step("sent continuation reaction", {
            runId: candidate.runId,
            sessionKey: candidate.sessionKey,
            threadId: route.threadId,
            reactionMessageId,
            emoji: CONTINUATION_REACTION_EMOJI,
        });
    }
    catch (error) {
        logger.error("continuation reaction failed", {
            runId: candidate.runId,
            sessionKey: candidate.sessionKey,
            threadId: route.threadId,
            reactionMessageId,
            error: error instanceof Error ? error.message : String(error),
        });
    }
}
async function launchEligibleContinuation(runtime, context, evaluated) {
    const { config, logger, dedupe, api, deps } = runtime;
    const { candidate, dedupeKey, route, wakeContext, sessionFile } = context;
    const { decision, validatorModel } = evaluated;
    dedupe.record(dedupeKey, {
        createdAt: Date.now(),
        reason: decision.reason,
        threadId: route.threadId,
    });
    logger.step("recorded continuation dedupe entry", {
        runId: candidate.runId,
        sessionKey: candidate.sessionKey,
        dedupeKey,
        reason: decision.reason,
        threadId: route.threadId,
    });
    try {
        logger.step("launching continuation", {
            runId: candidate.runId,
            sessionKey: candidate.sessionKey,
            sessionFile,
            threadId: route.threadId,
            currentMessageId: wakeContext.currentMessageId,
            currentChannelId: wakeContext.currentChannelId,
            replyToMode: wakeContext.replyToMode,
            timeoutMs: normalizeTimeoutMs(api, config.timeoutMs),
            reason: decision.reason,
            ...(validatorModel ? { validatorModel } : {}),
        });
        await sendContinuationReaction(runtime, context);
        const launchResult = await deps.launchContinuation(api, {
            candidate,
            decision,
            sessionRoute: route,
            wakeContext,
            sessionFile,
            timeoutMs: normalizeTimeoutMs(api, config.timeoutMs),
        }, logger);
        dedupe.setLaunchedFollowUpRunId(dedupeKey, launchResult.followUpRunId);
        logger.step("launched continuation", {
            runId: candidate.runId,
            followUpRunId: launchResult.followUpRunId,
            sessionKey: candidate.sessionKey,
            threadId: route.threadId,
            reason: decision.reason,
            ...(validatorModel ? { validatorModel } : {}),
        });
    }
    catch (error) {
        logger.error("continuation launch failed", {
            runId: candidate.runId,
            sessionKey: candidate.sessionKey,
            reason: decision.reason,
            ...(validatorModel ? { validatorModel } : {}),
            error: error instanceof Error ? error.message : String(error),
        });
    }
}
export function registerKeepGoingPlugin(api, deps = {}) {
    const config = resolveKeepGoingConfig(api.pluginConfig);
    const resolvedDeps = { ...DEFAULT_DEPS, ...deps };
    const runtime = {
        api,
        config,
        logger: createKeepGoingLogger(api.runtime.logging.getChildLogger({ plugin: api.id }), config.debug_logs),
        dedupe: new OneShotDedupe(),
        activeSubagents: new ActiveSubagentTracker(),
        sessionActivity: new SessionActivityTracker(),
        deps: resolvedDeps,
    };
    runtime.logger.step("registered", {
        enabled: config.enabled,
        debug_logs: config.debug_logs,
        channels: config.channels,
        timeoutMs: config.timeoutMs,
        validatorModel: config.validator.llm.model,
    });
    api.runtime.events.onSessionTranscriptUpdate((update) => {
        runtime.sessionActivity.recordTranscriptUpdate(update);
        runtime.logger.step("recorded session transcript update", {
            sessionKey: update.sessionKey,
            sessionFile: update.sessionFile,
            messageId: update.messageId,
            role: getMessageRole(update.message),
        });
    });
    api.runtime.events.onAgentEvent((event) => {
        if (event.stream !== "lifecycle") {
            return;
        }
        const phase = typeof event.data?.phase === "string" ? event.data.phase : undefined;
        if (phase === "error") {
            runtime.sessionActivity.markRunEnded({
                sessionKey: event.sessionKey,
                runId: event.runId,
            });
            runtime.logger.step("observed lifecycle error event", {
                sessionKey: event.sessionKey,
                runId: event.runId,
                phase,
            });
        }
    });
    api.on("before_model_resolve", (_event, ctx) => {
        runtime.sessionActivity.markRunStarted({
            sessionKey: ctx.sessionKey,
            runId: ctx.runId,
            trigger: ctx.trigger,
            source: "before_model_resolve",
        });
        runtime.logger.step("before_model_resolve", {
            runId: ctx.runId,
            agentId: ctx.agentId,
            sessionId: ctx.sessionId,
            sessionKey: ctx.sessionKey,
            workspaceDir: ctx.workspaceDir,
            modelProviderId: ctx.modelProviderId,
            modelId: ctx.modelId,
            messageProvider: ctx.messageProvider,
            trigger: ctx.trigger,
            channelId: ctx.channelId,
        });
    });
    api.on("subagent_spawned", (event, ctx) => {
        runtime.activeSubagents.markSpawned({
            requesterSessionKey: ctx.requesterSessionKey,
            childSessionKey: event.childSessionKey,
        });
        runtime.logger.step("subagent spawned", {
            requesterSessionKey: ctx.requesterSessionKey,
            childSessionKey: event.childSessionKey,
            activeChildSessionKeys: runtime.activeSubagents.getActiveChildSessionKeys(ctx.requesterSessionKey),
        });
    });
    api.on("subagent_ended", (event, ctx) => {
        if (event.targetKind !== "subagent") {
            return;
        }
        runtime.activeSubagents.markEnded({
            requesterSessionKey: ctx.requesterSessionKey,
            childSessionKey: event.targetSessionKey,
        });
        runtime.logger.step("subagent ended", {
            requesterSessionKey: ctx.requesterSessionKey,
            childSessionKey: event.targetSessionKey,
            activeChildSessionKeys: runtime.activeSubagents.getActiveChildSessionKeys(ctx.requesterSessionKey),
        });
    });
    api.on("agent_end", async (event, ctx) => {
        runtime.sessionActivity.markRunEnded({
            sessionKey: ctx.sessionKey,
            runId: ctx.runId,
        });
        const runStartBarrier = runtime.sessionActivity.captureRunStartBarrier({
            sessionKey: ctx.sessionKey,
        });
        runtime.logger.step("agent_end received", {
            runId: ctx.runId,
            sessionId: ctx.sessionId,
            sessionKey: ctx.sessionKey,
            success: event.success,
            durationMs: event.durationMs,
            trigger: ctx.trigger,
            messageCount: event.messages.length,
            runStartBarrier,
        });
        try {
            if (!runtime.config.enabled) {
                runtime.logger.step("plugin disabled; skipping agent_end handling", {
                    runId: ctx.runId,
                    sessionKey: ctx.sessionKey,
                });
                return;
            }
            const eligible = resolveEligibleContinuationContext(runtime, event, ctx, runStartBarrier);
            if (!eligible) {
                return;
            }
            const evaluated = await evaluateDecision(runtime, eligible.candidate);
            if (!evaluated) {
                return;
            }
            if (shouldAbortBeforeLaunch(runtime, eligible, evaluated)) {
                return;
            }
            await launchEligibleContinuation(runtime, eligible, evaluated);
        }
        finally {
            runtime.sessionActivity.clearRun(ctx.runId);
            runtime.logger.step("cleared run tracking", {
                runId: ctx.runId,
                sessionKey: ctx.sessionKey,
            });
        }
    });
}
