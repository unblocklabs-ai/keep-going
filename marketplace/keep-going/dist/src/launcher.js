import crypto from "node:crypto";
import { createReplyDispatcher } from "openclaw/plugin-sdk/reply-runtime";
import { deliverChannelPayload } from "./channel-delivery.js";
import { KEEP_GOING_FOLLOW_UP_RUN_ID_PREFIX, KEEP_GOING_SYNTHETIC_WAKE_PREFIX, } from "./constants.js";
import { normalizeString } from "./normalize.js";
function buildContinuationWakePrompt(params) {
    const instruction = params.decision.followUpInstruction?.trim();
    const nextStep = instruction || "Reassess the task and continue only if there is a clear remaining actionable step.";
    return [
        KEEP_GOING_SYNTHETIC_WAKE_PREFIX,
        "A validator thinks your previous turn may have ended before the task was fully handled.",
        "",
        "Reassess the latest conversation state. If there is still useful, actionable work remaining, continue with the next step. If the task is complete, no longer relevant, or blocked, do not invent work.",
        "",
        'For a visible progress update that should not end your turn, use `message(action="send", ...)` and keep working in the same turn.',
        "Use a normal assistant reply only when you intend to end your turn.",
        "",
        "If blocked, state the exact blocker briefly. If there is nothing useful to do, reply `NO_REPLY`.",
        "",
        `Validator-suggested next step: ${nextStep}`,
    ].join("\n");
}
export function resolveContinuationSessionFile(api, params) {
    return api.runtime.agent.session.resolveSessionFilePath(params.candidate.sessionId, params.sessionRoute.sessionFile ? { sessionFile: params.sessionRoute.sessionFile } : undefined, { agentId: params.candidate.agentId });
}
export function resolveContinuationModelRoute(params) {
    return {
        provider: normalizeString(params.sessionRoute.modelProviderId) ??
            normalizeString(params.candidate.modelProviderId),
        model: normalizeString(params.sessionRoute.modelId) ?? normalizeString(params.candidate.modelId),
    };
}
async function deliverContinuationReplyPayload(api, params, payload) {
    if (!params.sessionRoute.channel || !params.sessionRoute.to) {
        throw new Error("missing channel route for continuation reply delivery");
    }
    const isSlackChannel = params.sessionRoute.channel === "slack";
    await deliverChannelPayload(api, {
        channel: params.sessionRoute.channel,
        operation: "continuation reply",
        to: params.sessionRoute.to,
        text: typeof payload.text === "string" ? payload.text : "",
        payload,
        threadId: params.sessionRoute.threadId,
        replyToId: isSlackChannel
            ? undefined
            : payload.replyToId ??
                (params.wakeContext.currentMessageId ? String(params.wakeContext.currentMessageId) : undefined),
        accountId: params.sessionRoute.accountId,
    });
}
export async function launchContinuation(api, params, logger) {
    const followUpRunId = `${KEEP_GOING_FOLLOW_UP_RUN_ID_PREFIX}${crypto.randomUUID()}`;
    const { provider, model } = resolveContinuationModelRoute(params);
    const prompt = buildContinuationWakePrompt(params);
    if (!provider || !model) {
        logger?.error("continuation wake aborted before launch", {
            runId: params.candidate.runId,
            followUpRunId,
            sessionId: params.candidate.sessionId,
            sessionKey: params.candidate.sessionKey,
            sessionFile: params.sessionFile,
            hasProvider: Boolean(provider),
            hasModel: Boolean(model),
            threadId: params.sessionRoute.threadId,
            channel: params.sessionRoute.channel,
        });
        throw new Error("missing provider/model for continuation launch");
    }
    logger?.step("attempting continuation wake", {
        runId: params.candidate.runId,
        followUpRunId,
        sessionId: params.candidate.sessionId,
        sessionKey: params.candidate.sessionKey,
        sessionFile: params.sessionFile,
        provider,
        model,
        timeoutMs: params.timeoutMs,
        threadId: params.sessionRoute.threadId,
        channel: params.sessionRoute.channel,
        currentChannelId: params.wakeContext.currentChannelId,
        currentThreadTs: params.wakeContext.currentThreadTs,
        currentMessageId: params.wakeContext.currentMessageId,
        replyToMode: params.wakeContext.replyToMode,
        hasAuthProfileId: Boolean(params.sessionRoute.authProfileId),
        hasFollowUpInstruction: Boolean(params.decision.followUpInstruction),
    });
    const effectiveMessagesConfig = params.candidate.agentId
        ? api.runtime.channel.reply.resolveEffectiveMessagesConfig(api.config, params.candidate.agentId, {
            channel: params.sessionRoute.channel,
            accountId: params.sessionRoute.accountId,
        })
        : undefined;
    const humanDelay = params.candidate.agentId
        ? api.runtime.channel.reply.resolveHumanDelayConfig(api.config, params.candidate.agentId)
        : undefined;
    const replyDispatcher = createReplyDispatcher({
        responsePrefix: effectiveMessagesConfig?.responsePrefix,
        humanDelay,
        deliver: async (payload, info) => {
            logger?.step("dispatching continuation reply", {
                runId: params.candidate.runId,
                followUpRunId,
                kind: info.kind,
                hasText: Boolean(payload.text?.trim()),
                mediaCount: Array.isArray(payload.mediaUrls)
                    ? payload.mediaUrls.length
                    : payload.mediaUrl
                        ? 1
                        : 0,
                threadId: params.sessionRoute.threadId,
                replyToId: params.wakeContext.currentMessageId,
            });
            await deliverContinuationReplyPayload(api, params, payload);
        },
        onError: (error, info) => {
            logger?.error("continuation reply dispatch failed", {
                runId: params.candidate.runId,
                followUpRunId,
                kind: info.kind,
                error,
                threadId: params.sessionRoute.threadId,
                replyToId: params.wakeContext.currentMessageId,
            });
        },
    });
    logger?.step("continuation reply bridge ready", {
        runId: params.candidate.runId,
        followUpRunId,
        channel: params.sessionRoute.channel,
        to: params.sessionRoute.to,
        threadId: params.sessionRoute.threadId,
        replyToId: params.wakeContext.currentMessageId,
        responsePrefix: effectiveMessagesConfig?.responsePrefix,
        hasHumanDelay: Boolean(humanDelay),
    });
    let runError;
    try {
        await api.runtime.agent.runEmbeddedPiAgent({
            sessionId: params.candidate.sessionId,
            sessionKey: params.candidate.sessionKey,
            sessionFile: params.sessionFile,
            workspaceDir: params.candidate.workspaceDir,
            config: api.config,
            prompt,
            transcriptPrompt: prompt,
            provider,
            model,
            authProfileId: params.sessionRoute.authProfileId,
            timeoutMs: params.timeoutMs,
            runId: followUpRunId,
            trigger: "manual",
            messageChannel: params.sessionRoute.channel,
            messageProvider: params.candidate.messageProvider,
            messageTo: params.sessionRoute.to,
            messageThreadId: params.sessionRoute.threadId,
            agentAccountId: params.sessionRoute.accountId,
            currentChannelId: params.wakeContext.currentChannelId,
            currentThreadTs: params.wakeContext.currentThreadTs,
            currentMessageId: params.wakeContext.currentMessageId,
            replyToMode: params.wakeContext.replyToMode,
            onBlockReply: async (payload) => {
                replyDispatcher.sendBlockReply(payload);
            },
            onToolResult: async (payload) => {
                replyDispatcher.sendToolResult(payload);
            },
        });
    }
    catch (error) {
        runError = error;
    }
    finally {
        replyDispatcher.markComplete();
        await replyDispatcher.waitForIdle();
    }
    if (runError) {
        throw runError;
    }
    const failedCounts = replyDispatcher.getFailedCounts();
    const failedTotal = Object.values(failedCounts).reduce((sum, count) => sum + count, 0);
    if (failedTotal > 0) {
        throw new Error(`continuation reply dispatch failed (tool=${failedCounts.tool}, block=${failedCounts.block}, final=${failedCounts.final})`);
    }
    logger?.step("continuation wake request completed", {
        runId: params.candidate.runId,
        followUpRunId,
        sessionId: params.candidate.sessionId,
        sessionKey: params.candidate.sessionKey,
        threadId: params.sessionRoute.threadId,
        currentMessageId: params.wakeContext.currentMessageId,
    });
    return { followUpRunId };
}
