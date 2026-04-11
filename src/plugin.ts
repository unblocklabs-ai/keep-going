import { type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { ActiveSubagentTracker } from "./active-subagents.js";
import { resolveKeepGoingConfig } from "./config.js";
import { KEEP_GOING_FOLLOW_UP_RUN_ID_PREFIX } from "./constants.js";
import { OneShotDedupe } from "./dedupe.js";
import { launchContinuation, resolveContinuationSessionFile } from "./launcher.js";
import { validateContinuationWithLlm } from "./llm-validator.js";
import { lastAssistantHasSubagentSpawnToolCall } from "./messages.js";
import { SessionActivityTracker } from "./session-activity.js";
import { isSubagentSessionKey, resolveSessionRoute } from "./session-route.js";
import type {
  ContinuationCandidate,
  ContinuationDecision,
  KeepGoingPluginConfig,
  SessionRoute,
} from "./types.js";
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

type Logger = {
  debug?: (message: string, meta?: Record<string, unknown>) => void;
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
};

type KeepGoingRuntime = {
  api: OpenClawPluginApi;
  config: KeepGoingPluginConfig;
  logger: Logger;
  dedupe: OneShotDedupe;
  activeSubagents: ActiveSubagentTracker;
  sessionActivity: SessionActivityTracker;
};

type EligibleContinuationContext = {
  candidate: ContinuationCandidate;
  dedupeKey: string;
  route: SessionRoute & { lookupStatus: "ok" };
  sessionFile: string;
  transcriptSnapshot: ReturnType<SessionActivityTracker["captureSnapshot"]>;
};

type EvaluatedDecision = {
  decision: ContinuationDecision;
  validatorModel?: string;
};

type SkipDecision = {
  reason: string;
  metadata?: Record<string, unknown>;
};

type CandidateGuardInput = {
  candidate: ContinuationCandidate;
  activeSubagents: ActiveSubagentTracker;
};

type RouteGuardInput = {
  candidate: ContinuationCandidate;
  config: KeepGoingPluginConfig;
  route: SessionRoute & { lookupStatus: "ok" };
};

type CandidateGuard = (input: CandidateGuardInput) => SkipDecision | undefined;
type RouteGuard = (input: RouteGuardInput) => SkipDecision | undefined;
type ResolvedSessionRoute = SessionRoute & { lookupStatus: "ok" };

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

function logSkip(
  logger: Logger,
  reason: string,
  metadata?: Record<string, unknown>,
): void {
  logger.debug?.(`keep-going skipped: ${reason}`, metadata);
}

const CANDIDATE_GUARDS: CandidateGuard[] = [
  ({ candidate }) =>
    candidate.success ? undefined : { reason: "unsuccessful run", metadata: { runId: candidate.runId } },
  ({ candidate }) =>
    lastAssistantHasSubagentSpawnToolCall(candidate.messages)
      ? {
          reason: "subagent handoff run",
          metadata: {
            runId: candidate.runId,
            sessionKey: candidate.sessionKey,
          },
        }
      : undefined,
  ({ candidate, activeSubagents }) =>
    activeSubagents.hasActiveChildren(candidate.sessionKey)
      ? {
          reason: "subagent still in flight",
          metadata: {
            runId: candidate.runId,
            sessionKey: candidate.sessionKey,
            activeChildSessionKeys: activeSubagents.getActiveChildSessionKeys(candidate.sessionKey),
          },
        }
      : undefined,
  ({ candidate }) =>
    candidate.runId.startsWith(KEEP_GOING_FOLLOW_UP_RUN_ID_PREFIX)
      ? {
          reason: "plugin-started continuation run",
          metadata: { runId: candidate.runId },
        }
      : undefined,
  ({ candidate }) =>
    candidate.trigger === "heartbeat" || candidate.trigger === "cron"
      ? {
          reason: "background trigger",
          metadata: {
            runId: candidate.runId,
            trigger: candidate.trigger,
          },
        }
      : undefined,
  ({ candidate }) =>
    isSubagentSessionKey(candidate.sessionKey)
      ? {
          reason: "subagent session key",
          metadata: {
            runId: candidate.runId,
            sessionKey: candidate.sessionKey,
          },
        }
      : undefined,
];

const ROUTE_GUARDS: RouteGuard[] = [
  ({ candidate, config, route }) =>
    !route.isSlack || !config.channels.includes("slack")
      ? {
          reason: "non-slack session",
          metadata: {
            runId: candidate.runId,
            channel: route.channel,
          },
        }
      : undefined,
  ({ candidate, route }) =>
    route.spawnedBy
      ? {
          reason: "spawned session",
          metadata: {
            runId: candidate.runId,
            sessionKey: candidate.sessionKey,
            spawnedBy: route.spawnedBy,
          },
        }
      : undefined,
];

function runGuards<TInput>(
  guards: Array<(input: TInput) => SkipDecision | undefined>,
  input: TInput,
): SkipDecision | undefined {
  for (const guard of guards) {
    const result = guard(input);
    if (result) {
      return result;
    }
  }
  return undefined;
}

function isResolvedSessionRoute(route: SessionRoute): route is ResolvedSessionRoute {
  return route.lookupStatus === "ok";
}

function recordLifecyclePhase(
  sessionActivity: SessionActivityTracker,
  params: {
    phase: "start" | "end";
    sessionKey?: string;
    runId?: string;
  },
): void {
  if (params.phase === "start") {
    sessionActivity.markRunStarted({
      sessionKey: params.sessionKey,
      runId: params.runId,
    });
    return;
  }
  sessionActivity.markRunEnded({
    sessionKey: params.sessionKey,
    runId: params.runId,
  });
}

function resolveEligibleContinuationContext(
  runtime: KeepGoingRuntime,
  event: AgentEndEvent,
  ctx: AgentContext,
): EligibleContinuationContext | undefined {
  const { api, config, logger, dedupe, activeSubagents, sessionActivity } = runtime;

  const candidate = buildCandidate(event, ctx);
  if (!candidate) {
    logSkip(logger, "missing candidate context");
    return undefined;
  }

  const candidateSkip = runGuards(CANDIDATE_GUARDS, {
    candidate,
    activeSubagents,
  });
  if (candidateSkip) {
    logSkip(logger, candidateSkip.reason, candidateSkip.metadata);
    return undefined;
  }

  const route = resolveSessionRoute(api, {
    agentId: ctx.agentId,
    sessionKey: candidate.sessionKey,
  });

  if (route.lookupStatus === "error") {
    logger.warn("keep-going skipped: session lookup failed", {
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

  const routeSkip = runGuards(ROUTE_GUARDS, {
    candidate,
    config,
    route,
  });
  if (routeSkip) {
    logSkip(logger, routeSkip.reason, routeSkip.metadata);
    return undefined;
  }

  const sessionFile = resolveContinuationSessionFile(api, {
    candidate,
    sessionRoute: route,
  });
  const transcriptSnapshot = sessionActivity.captureSnapshot({
    sessionKey: candidate.sessionKey,
    sessionFile,
  });

  const dedupeKey = dedupe.makeKey({
    sessionKey: candidate.sessionKey,
    runId: candidate.runId,
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
    sessionFile,
    transcriptSnapshot,
  };
}

async function evaluateDecision(
  runtime: KeepGoingRuntime,
  candidate: ContinuationCandidate,
): Promise<EvaluatedDecision | undefined> {
  const { config, logger, sessionActivity } = runtime;

  switch (config.validator.mode) {
    case "llm":
      try {
        const decision = await validateContinuationWithLlm({
          candidate,
          config: config.validator.llm,
          context: {
            runTranscriptMessages: sessionActivity.getRunTranscriptMessages(candidate.runId),
          },
        });
        return {
          decision,
          validatorModel: decision.validatorModel,
        };
      } catch (error) {
        logger.warn("keep-going skipped: llm validator failed", {
          runId: candidate.runId,
          sessionKey: candidate.sessionKey,
          model: config.validator.llm.model,
          provider: config.validator.llm.provider,
          error: error instanceof Error ? error.message : String(error),
        });
        return undefined;
      }
    case "heuristic":
      if (!config.validator.heuristic.enabled) {
        logSkip(logger, "heuristic disabled", { runId: candidate.runId });
        return undefined;
      }
      return {
        decision: validateContinuation(candidate),
      };
    default:
      return undefined;
  }
}

function shouldAbortBeforeLaunch(
  runtime: KeepGoingRuntime,
  context: EligibleContinuationContext,
  evaluated: EvaluatedDecision,
): boolean {
  const { logger, sessionActivity } = runtime;
  const { candidate, route, sessionFile, transcriptSnapshot } = context;
  const { decision, validatorModel } = evaluated;

  if (!decision.continue) {
    logSkip(logger, "validator declined", {
      runId: candidate.runId,
      reason: decision.reason,
      validatorMode: runtime.config.validator.mode,
      ...(validatorModel ? { validatorModel } : {}),
    });
    return true;
  }

  if (sessionActivity.hasActiveRun(candidate.sessionKey)) {
    logSkip(logger, "session became active again", {
      runId: candidate.runId,
      sessionKey: candidate.sessionKey,
    });
    return true;
  }

  if (
    sessionActivity.hasTranscriptChanged(transcriptSnapshot, {
      sessionKey: candidate.sessionKey,
      sessionFile,
    })
  ) {
    logSkip(logger, "transcript changed before continuation launch", {
      runId: candidate.runId,
      sessionKey: candidate.sessionKey,
      threadId: route.threadId,
    });
    return true;
  }

  return false;
}

async function launchEligibleContinuation(
  runtime: KeepGoingRuntime,
  context: EligibleContinuationContext,
  evaluated: EvaluatedDecision,
): Promise<void> {
  const { config, logger, dedupe, api } = runtime;
  const { candidate, dedupeKey, route, sessionFile } = context;
  const { decision, validatorModel } = evaluated;

  dedupe.record(dedupeKey, {
    createdAt: Date.now(),
    reason: decision.reason,
    threadId: route.threadId,
  });

  try {
    const launchResult = await launchContinuation(api, {
      candidate,
      decision,
      sessionRoute: route,
      sessionFile,
      timeoutMs: normalizeTimeoutMs(api, config.timeoutMs),
    });
    dedupe.setLaunchedFollowUpRunId(dedupeKey, launchResult.followUpRunId);
    logger.info("keep-going launched continuation", {
      runId: candidate.runId,
      followUpRunId: launchResult.followUpRunId,
      sessionKey: candidate.sessionKey,
      threadId: route.threadId,
      reason: decision.reason,
      validatorMode: config.validator.mode,
      ...(validatorModel ? { validatorModel } : {}),
    });
  } catch (error) {
    logger.warn("keep-going continuation launch failed", {
      runId: candidate.runId,
      sessionKey: candidate.sessionKey,
      reason: decision.reason,
      validatorMode: config.validator.mode,
      ...(validatorModel ? { validatorModel } : {}),
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function registerKeepGoingPlugin(api: OpenClawPluginApi): void {
  const config = resolveKeepGoingConfig(api.pluginConfig);
  const runtime: KeepGoingRuntime = {
    api,
    config,
    logger: api.runtime.logging.getChildLogger({ plugin: api.id }),
    dedupe: new OneShotDedupe(),
    activeSubagents: new ActiveSubagentTracker(),
    sessionActivity: new SessionActivityTracker(),
  };

  api.runtime.events.onSessionTranscriptUpdate((update) => {
    runtime.sessionActivity.recordTranscriptUpdate(update);
  });

  api.runtime.events.onAgentEvent((event) => {
    if (event.stream !== "lifecycle") {
      return;
    }
    const phase = typeof event.data?.phase === "string" ? event.data.phase : undefined;
    switch (phase) {
      case "start":
        recordLifecyclePhase(runtime.sessionActivity, {
          phase: "start",
          sessionKey: event.sessionKey,
          runId: event.runId,
        });
        break;
      case "end":
      case "error":
        recordLifecyclePhase(runtime.sessionActivity, {
          phase: "end",
          sessionKey: event.sessionKey,
          runId: event.runId,
        });
        break;
      default:
        break;
    }
  });

  api.on("before_agent_start", (_event, ctx) => {
    recordLifecyclePhase(runtime.sessionActivity, {
      phase: "start",
      sessionKey: ctx.sessionKey,
      runId: ctx.runId,
    });
  });

  api.on("subagent_spawned", (event, ctx) => {
    runtime.activeSubagents.markSpawned({
      requesterSessionKey: ctx.requesterSessionKey,
      childSessionKey: event.childSessionKey,
      runId: event.runId,
    });
  });

  api.on("subagent_ended", (event, ctx) => {
    if (event.targetKind !== "subagent") {
      return;
    }
    runtime.activeSubagents.markEnded({
      requesterSessionKey: ctx.requesterSessionKey,
      childSessionKey: event.targetSessionKey,
      runId: event.runId,
    });
  });

  api.on("agent_end", async (event, ctx) => {
    recordLifecyclePhase(runtime.sessionActivity, {
      phase: "end",
      sessionKey: ctx.sessionKey,
      runId: ctx.runId,
    });

    try {
      if (!runtime.config.enabled) {
        return;
      }

      const eligible = resolveEligibleContinuationContext(runtime, event, ctx);
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
    } finally {
      runtime.sessionActivity.clearRun(ctx.runId);
    }
  });
}
