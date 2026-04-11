import crypto from "node:crypto";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { KEEP_GOING_FOLLOW_UP_RUN_ID_PREFIX } from "./constants.js";
import type { LaunchContinuationParams } from "./types.js";

export async function launchContinuation(
  api: OpenClawPluginApi,
  params: LaunchContinuationParams,
): Promise<{ followUpRunId: string }> {
  const followUpRunId = `${KEEP_GOING_FOLLOW_UP_RUN_ID_PREFIX}${crypto.randomUUID()}`;
  const extraSystemPrompt = [
    "A completion validator flagged the previous turn as possibly incomplete.",
    "The validator may be wrong.",
    "If the previous turn was actually complete, reply briefly that it is complete and stop.",
    "If you are truly blocked, state the exact blocker briefly and stop.",
    params.decision.followUpInstruction ??
      "Otherwise, perform the next remaining actionable step now.",
    "Before your first tool call, send a brief interim update that you are continuing the remaining work from the previous turn.",
  ].join("\n");

  await api.runtime.agent.runEmbeddedPiAgent({
    sessionId: params.candidate.sessionId,
    sessionKey: params.candidate.sessionKey,
    sessionFile: api.runtime.agent.session.resolveSessionFilePath(
      params.candidate.sessionId,
      params.sessionRoute.sessionFile ? { sessionFile: params.sessionRoute.sessionFile } : undefined,
      { agentId: params.candidate.agentId },
    ),
    workspaceDir: params.candidate.workspaceDir,
    config: api.config,
    prompt: "Continue the previous task.",
    provider: params.candidate.modelProviderId,
    model: params.candidate.modelId,
    timeoutMs: params.timeoutMs,
    runId: followUpRunId,
    trigger: "manual",
    messageChannel: params.sessionRoute.channel,
    messageProvider: params.candidate.messageProvider,
    messageTo: params.sessionRoute.to,
    messageThreadId: params.sessionRoute.threadId,
    agentAccountId: params.sessionRoute.accountId,
    extraSystemPrompt,
  });

  return { followUpRunId };
}
