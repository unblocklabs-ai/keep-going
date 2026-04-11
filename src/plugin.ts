import { type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { resolveKeepGoingConfig } from "./config.js";
import { OneShotDedupe } from "./dedupe.js";
import { launchContinuation } from "./launcher.js";
import { resolveSessionRoute, isSubagentSessionKey } from "./session-route.js";
import type { ContinuationCandidate } from "./types.js";
import { validateContinuation } from "./validator.js";

type AgentEndEvent = {
  messages: unknown[];
  success: boolean;
  error?: string;
  durationMs?: number;
};

type AgentContext = {
  runId?: string;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  workspaceDir?: string;
  modelProviderId?: string;
  modelId?: string;
  messageProvider?: string;
  trigger?: string;
  channelId?: string;
};

function normalizeTimeoutMs(
  api: OpenClawPluginApi,
  configuredTimeoutMs: number | undefined,
): number {
  return api.runtime.agent.resolveAgentTimeoutMs({
    cfg: api.config,
    overrideMs: configuredTimeoutMs,
  });
}

function buildCandidate(
  event: AgentEndEvent,
  ctx: AgentContext,
): ContinuationCandidate | undefined {
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

export function registerKeepGoingPlugin(api: OpenClawPluginApi): void {
  const config = resolveKeepGoingConfig(api.pluginConfig);
  const logger = api.runtime.logging.getChildLogger({ plugin: api.id });
  const dedupe = new OneShotDedupe();

  api.on("agent_end", async (event, ctx) => {
    if (!config.enabled) {
      return;
    }

    const candidate = buildCandidate(event, ctx);
    if (!candidate) {
      logger.debug?.("keep-going skipped: missing candidate context");
      return;
    }

    if (!candidate.success) {
      logger.debug?.("keep-going skipped: unsuccessful run", { runId: candidate.runId });
      return;
    }

    if (candidate.trigger === "heartbeat" || candidate.trigger === "cron") {
      logger.debug?.("keep-going skipped: background trigger", {
        runId: candidate.runId,
        trigger: candidate.trigger,
      });
      return;
    }

    if (isSubagentSessionKey(candidate.sessionKey)) {
      logger.debug?.("keep-going skipped: subagent session key", {
        runId: candidate.runId,
        sessionKey: candidate.sessionKey,
      });
      return;
    }

    const route = resolveSessionRoute(api, {
      agentId: ctx.agentId,
      sessionKey: candidate.sessionKey,
    });

    if (!route.isSlack || !config.channels.includes("slack")) {
      logger.debug?.("keep-going skipped: non-slack session", {
        runId: candidate.runId,
        channel: route.channel,
      });
      return;
    }

    if (route.spawnedBy) {
      logger.debug?.("keep-going skipped: spawned session", {
        runId: candidate.runId,
        sessionKey: candidate.sessionKey,
        spawnedBy: route.spawnedBy,
      });
      return;
    }

    const dedupeKey = dedupe.makeKey({
      sessionKey: candidate.sessionKey,
      runId: candidate.runId,
    });
    if (dedupe.has(dedupeKey)) {
      logger.debug?.("keep-going skipped: already retriggered", {
        runId: candidate.runId,
        sessionKey: candidate.sessionKey,
      });
      return;
    }

    if (!config.heuristic.enabled) {
      logger.debug?.("keep-going skipped: heuristic disabled", { runId: candidate.runId });
      return;
    }

    const decision = validateContinuation(candidate);
    if (!decision.continue) {
      logger.debug?.("keep-going skipped: validator declined", {
        runId: candidate.runId,
        reason: decision.reason,
      });
      return;
    }

    dedupe.record(dedupeKey, {
      createdAt: Date.now(),
      reason: decision.reason,
    });

    try {
      const launchResult = await launchContinuation(api, {
        candidate,
        decision,
        sessionRoute: route,
        timeoutMs: normalizeTimeoutMs(api, config.timeoutMs),
      });
      dedupe.setLaunchedFollowUpRunId(dedupeKey, launchResult.followUpRunId);
      logger.info("keep-going launched continuation", {
        runId: candidate.runId,
        followUpRunId: launchResult.followUpRunId,
        sessionKey: candidate.sessionKey,
        threadId: route.threadId,
        reason: decision.reason,
      });
    } catch (error) {
      logger.warn("keep-going continuation launch failed", {
        runId: candidate.runId,
        sessionKey: candidate.sessionKey,
        reason: decision.reason,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
