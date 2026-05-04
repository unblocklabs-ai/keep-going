import test from "node:test";
import assert from "node:assert/strict";
import type { OpenClawPluginApi, RuntimeLogger } from "openclaw/plugin-sdk";
import { KEEP_GOING_SYNTHETIC_WAKE_PREFIX } from "../src/constants.js";
import { launchContinuation } from "../src/launcher.js";
import { registerKeepGoingPlugin } from "../src/plugin.js";
import type { ContinuationValidationContext, LaunchContinuationParams } from "../src/types.js";

const SESSION_KEY = "agent:main:slack:channel:c123:thread:1712345678.000100";
const SESSION_FILE = "/virtual/session.jsonl";

type MockLoggerCall = {
  message: string;
  meta?: Record<string, unknown>;
};

type MockApiOptions = {
  runEmbeddedPiAgent?: (params: Record<string, unknown>) => Promise<unknown>;
  loadOutboundAdapter?: (channelId: string) => Promise<{
    sendPayload?: (ctx: Record<string, unknown>) => Promise<unknown>;
    sendText?: (ctx: Record<string, unknown>) => Promise<unknown>;
    sendMedia?: (ctx: Record<string, unknown>) => Promise<unknown>;
  } | undefined>;
};

function createMockApi(
  pluginConfig: Record<string, unknown> = { enabled: true },
  options: MockApiOptions = {},
) {
  const hooks = new Map<string, (...args: unknown[]) => unknown>();
  let onTranscriptUpdate:
    | ((update: {
        sessionFile: string;
        sessionKey?: string;
        message?: unknown;
        messageId?: string;
      }) => void)
    | undefined;
  let onAgentEvent:
    | ((event: { stream?: string; data?: { phase?: string }; sessionKey?: string; runId?: string }) => void)
    | undefined;

  const logs = {
    debug: [] as MockLoggerCall[],
    info: [] as MockLoggerCall[],
    warn: [] as MockLoggerCall[],
    error: [] as MockLoggerCall[],
  };

  const logger: RuntimeLogger = {
    debug: (message: string, meta?: Record<string, unknown>) => logs.debug.push({ message, meta }),
    info: (message: string, meta?: Record<string, unknown>) => logs.info.push({ message, meta }),
    warn: (message: string, meta?: Record<string, unknown>) => logs.warn.push({ message, meta }),
    error: (message: string, meta?: Record<string, unknown>) => logs.error.push({ message, meta }),
  };

  const sessionStore = {
    [SESSION_KEY]: {
      sessionFile: SESSION_FILE,
      deliveryContext: {
      channel: "slack",
      to: "channel:C123",
      accountId: "default",
      threadId: "1712345678.000100",
      },
      modelProvider: "openai-codex",
      model: "gpt-5.4",
    },
  };

  const api = {
    id: "keep-going",
    pluginConfig,
    config: {
      session: {
        store: "/virtual/sessions.json",
      },
      channels: {
        slack: {
          replyToMode: "all",
        },
      },
    },
    runtime: {
      logging: {
        getChildLogger: () => logger,
      },
      channel: {
        reply: {
          resolveEffectiveMessagesConfig: () => ({
            messagePrefix: "",
            responsePrefix: undefined,
          }),
          resolveHumanDelayConfig: () => undefined,
        },
        outbound: {
          loadAdapter: async (channelId: string) =>
            options.loadOutboundAdapter
              ? await options.loadOutboundAdapter(channelId)
              : undefined,
        },
      },
      events: {
        onSessionTranscriptUpdate: (
          handler: (update: {
            sessionFile: string;
            sessionKey?: string;
            message?: unknown;
            messageId?: string;
          }) => void,
        ) => {
          onTranscriptUpdate = handler;
        },
        onAgentEvent: (
          handler: (event: {
            stream?: string;
            data?: { phase?: string };
            sessionKey?: string;
            runId?: string;
          }) => void,
        ) => {
          onAgentEvent = handler;
        },
      },
      agent: {
        resolveAgentTimeoutMs: () => 60_000,
        session: {
          resolveStorePath: () => "/virtual/sessions.json",
          loadSessionStore: () => sessionStore,
          resolveSessionFilePath: () => SESSION_FILE,
        },
        runEmbeddedPiAgent: options.runEmbeddedPiAgent
          ? async (params: Record<string, unknown>) => await options.runEmbeddedPiAgent?.(params)
          : async () => {
              throw new Error("runEmbeddedPiAgent should not be called in this test");
            },
      },
    },
    on: (hookName: string, handler: (...args: unknown[]) => unknown) => {
      hooks.set(hookName, handler);
    },
  };

  return {
    api: api as unknown as OpenClawPluginApi,
    hooks,
    logs,
    emitTranscriptUpdate: (update: {
      sessionFile: string;
      sessionKey?: string;
      message?: unknown;
      messageId?: string;
    }) => {
      onTranscriptUpdate?.(update);
    },
    emitAgentEvent: (event: {
      stream?: string;
      data?: { phase?: string };
      sessionKey?: string;
      runId?: string;
    }) => {
      onAgentEvent?.(event);
    },
  };
}

function createRunContext() {
  return {
    runId: "run-1",
    agentId: "main",
    sessionId: "session-1",
    sessionKey: SESSION_KEY,
    workspaceDir: "/workspace",
    modelProviderId: "openai-codex",
    modelId: "gpt-5.4",
    messageProvider: "slack",
    channelId: "slack",
    trigger: "user",
  };
}

test("registerKeepGoingPlugin uses before_model_resolve instead of before_agent_start", () => {
  const { api, hooks } = createMockApi();

  registerKeepGoingPlugin(api, {
    validateContinuationWithLlm: async () => ({
      continue: false,
      reason: "done",
      validatorModel: "gpt-5.4-mini",
    }),
    launchContinuation: async () => ({ followUpRunId: "follow-up-1" }),
  });

  assert.equal(hooks.has("before_model_resolve"), true);
  assert.equal(hooks.has("before_agent_start"), false);
});

test("before_model_resolve still marks runs active for validator transcript context", async () => {
  const { api, hooks, emitTranscriptUpdate } = createMockApi();
  const validatorCalls: Array<{ context?: ContinuationValidationContext }> = [];

  registerKeepGoingPlugin(api, {
    validateContinuationWithLlm: async (input) => {
      validatorCalls.push({ context: input.context });
      return {
        continue: false,
        reason: "already complete",
        validatorModel: "gpt-5.4-mini",
      };
    },
    launchContinuation: async () => ({ followUpRunId: "follow-up-1" }),
  });

  const beforeModelResolve = hooks.get("before_model_resolve");
  const agentEnd = hooks.get("agent_end");

  assert.ok(beforeModelResolve);
  assert.ok(agentEnd);

  const runContext = createRunContext();

  await beforeModelResolve?.({ prompt: "Please continue the task." }, runContext);

  emitTranscriptUpdate({
    sessionFile: SESSION_FILE,
    sessionKey: SESSION_KEY,
    messageId: "msg-1",
    message: {
      role: "assistant",
      content: [{ type: "output_text", text: "I still need to finish the task." }],
    },
  });

  await agentEnd?.(
    {
      success: true,
      messages: [],
    },
    runContext,
  );

  assert.equal(validatorCalls.length, 1);
  assert.deepEqual(validatorCalls[0]?.context?.runTranscriptMessages, [
    { role: "assistant", text: "I still need to finish the task." },
  ]);
  assert.deepEqual(validatorCalls[0]?.context?.sessionTranscriptMessages, [
    { role: "assistant", text: "I still need to finish the task." },
  ]);
});

test("continuation launch reuses the last inbound Slack message id and reply context", async () => {
  const { api, hooks, emitTranscriptUpdate } = createMockApi({ enabled: true, debug_logs: true });
  const launchCalls: LaunchContinuationParams[] = [];

  registerKeepGoingPlugin(api, {
    validateContinuationWithLlm: async () => ({
      continue: true,
      reason: "unfinished work remains",
      validatorModel: "gpt-5.4-mini",
    }),
    launchContinuation: async (_api, params) => {
      launchCalls.push(params);
      return { followUpRunId: "follow-up-1" };
    },
  });

  const beforeModelResolve = hooks.get("before_model_resolve");
  const agentEnd = hooks.get("agent_end");
  const runContext = createRunContext();

  await beforeModelResolve?.({ prompt: "Please continue the task." }, runContext);

  emitTranscriptUpdate({
    sessionFile: SESSION_FILE,
    sessionKey: SESSION_KEY,
    messageId: "1776309280.777379",
    message: {
      role: "user",
      content: [
        {
          type: "input_text",
          text: [
            "System: [2026-04-16 03:13:57 UTC] Slack message in #proj-openclaw from Bek: Did the plugin wake you?",
            "",
            "Did the plugin wake you?",
          ].join("\n"),
        },
      ],
    },
  });
  emitTranscriptUpdate({
    sessionFile: SESSION_FILE,
    sessionKey: SESSION_KEY,
    messageId: "assistant-msg-1",
    message: {
      role: "assistant",
      content: [{ type: "output_text", text: "I should investigate that next." }],
    },
  });

  await agentEnd?.(
    {
      success: true,
      messages: [],
    },
    runContext,
  );

  assert.equal(launchCalls.length, 1);
  assert.equal(launchCalls[0]?.wakeContext.currentMessageId, "1776309280.777379");
  assert.equal(launchCalls[0]?.wakeContext.currentChannelId, "C123");
  assert.equal(launchCalls[0]?.wakeContext.currentThreadTs, "1712345678.000100");
  assert.equal(launchCalls[0]?.wakeContext.replyToMode, "all");
});

test("plugin-triggered continuation flow dispatches assistant replies to the stored Slack thread", async () => {
  const deliveredPayloads: Array<Record<string, unknown>> = [];
  let embeddedPrompt: string | undefined;
  let embeddedTranscriptPrompt: unknown;
  const { api, hooks, emitTranscriptUpdate } = createMockApi(
    { enabled: true, debug_logs: true },
    {
      loadOutboundAdapter: async (channelId) => {
        assert.equal(channelId, "slack");
        return {
          sendPayload: async (ctx: Record<string, unknown>) => {
            deliveredPayloads.push(ctx);
            return { ok: true };
          },
        };
      },
      runEmbeddedPiAgent: async (params: Record<string, unknown>) => {
        embeddedPrompt = typeof params.prompt === "string" ? params.prompt : undefined;
        embeddedTranscriptPrompt = params.transcriptPrompt;
        await (params.onBlockReply as (payload: { text: string }) => Promise<void>)({
          text: "It woke cleanly on 0.1.8...",
        });
        return {} as never;
      },
    },
  );

  registerKeepGoingPlugin(api, {
    validateContinuationWithLlm: async () => ({
      continue: true,
      reason: "unfinished work remains",
      validatorModel: "gpt-5.4-mini",
    }),
    launchContinuation,
  });

  const beforeModelResolve = hooks.get("before_model_resolve");
  const agentEnd = hooks.get("agent_end");
  const runContext = createRunContext();

  await beforeModelResolve?.({ prompt: "Please continue the task." }, runContext);

  emitTranscriptUpdate({
    sessionFile: SESSION_FILE,
    sessionKey: SESSION_KEY,
    messageId: "1776309280.777379",
    message: {
      role: "user",
      content: [
        {
          type: "input_text",
          text: "System: [2026-04-16 03:13:57 UTC] Slack message in #proj-openclaw from Bek\n\nDid the plugin wake you?",
        },
      ],
    },
  });

  await agentEnd?.(
    {
      success: true,
      messages: [],
    },
    runContext,
  );

  assert.equal(typeof embeddedPrompt, "string");
  assert.match(embeddedPrompt ?? "", new RegExp(`^\\${KEEP_GOING_SYNTHETIC_WAKE_PREFIX}`));
  assert.match(
    embeddedPrompt ?? "",
    /Resume the same task now\./,
  );
  assert.match(
    embeddedPrompt ?? "",
    /Only use a normal assistant reply when you intend to end your turn\./,
  );
  assert.equal(embeddedTranscriptPrompt, "");
  assert.equal(deliveredPayloads.length, 1);
  assert.equal(deliveredPayloads[0]?.to, "channel:C123");
  assert.equal(deliveredPayloads[0]?.threadId, "1712345678.000100");
  assert.equal(deliveredPayloads[0]?.replyToId, undefined);
  assert.deepEqual(deliveredPayloads[0]?.payload, {
    text: "It woke cleanly on 0.1.8...",
  });
});

test("validator-approved continuation is not blocked when the same run is re-observed during cleanup", async () => {
  const { api, hooks, logs } = createMockApi({ enabled: true, debug_logs: true });
  const launchCalls: LaunchContinuationParams[] = [];

  registerKeepGoingPlugin(api, {
    validateContinuationWithLlm: async () => {
      const beforeModelResolve = hooks.get("before_model_resolve");
      await beforeModelResolve?.({ prompt: "cleanup replay" }, createRunContext());
      return {
        continue: true,
        reason: "unfinished work remains",
        validatorModel: "gpt-5.4-mini",
      };
    },
    launchContinuation: async (_api, params) => {
      launchCalls.push(params);
      return { followUpRunId: "follow-up-1" };
    },
  });

  const beforeModelResolve = hooks.get("before_model_resolve");
  const agentEnd = hooks.get("agent_end");
  const runContext = createRunContext();

  await beforeModelResolve?.({ prompt: "Please continue the task." }, runContext);
  await agentEnd?.(
    {
      success: true,
      messages: [],
    },
    runContext,
  );

  assert.equal(launchCalls.length, 1);
  assert.equal(
    logs.info.some(
      (entry) => entry.message === "Keep-Going Plugin: skip: session became active again",
    ),
    false,
  );
});

test("validator-approved continuation is aborted when a distinct newer run starts during validation", async () => {
  const { api, hooks, logs, emitAgentEvent } = createMockApi({
    enabled: true,
    debug_logs: true,
  });
  const launchCalls: LaunchContinuationParams[] = [];

  registerKeepGoingPlugin(api, {
    validateContinuationWithLlm: async () => {
      const beforeModelResolve = hooks.get("before_model_resolve");
      const newerRunContext = {
        ...createRunContext(),
        runId: "run-2",
        sessionId: "session-2",
      };
      await beforeModelResolve?.({ prompt: "A newer run started." }, newerRunContext);
      emitAgentEvent({
        stream: "lifecycle",
        data: { phase: "error" },
        sessionKey: SESSION_KEY,
        runId: "run-2",
      });
      return {
        continue: true,
        reason: "unfinished work remains",
        validatorModel: "gpt-5.4-mini",
      };
    },
    launchContinuation: async (_api, params) => {
      launchCalls.push(params);
      return { followUpRunId: "follow-up-1" };
    },
  });

  const beforeModelResolve = hooks.get("before_model_resolve");
  const agentEnd = hooks.get("agent_end");
  const runContext = createRunContext();

  await beforeModelResolve?.({ prompt: "Please continue the task." }, runContext);
  await agentEnd?.(
    {
      success: true,
      messages: [],
    },
    runContext,
  );

  assert.equal(launchCalls.length, 0);
  const skipLog = logs.info.find(
    (entry) => entry.message === "Keep-Going Plugin: skip: session became active again",
  );
  assert.ok(skipLog);
  assert.equal(skipLog.meta?.candidateRunId, "run-1");
  assert.ok(Array.isArray(skipLog.meta?.newerRuns));
  assert.equal(skipLog.meta?.newerRuns.length, 1);
  assert.equal(skipLog.meta?.newerRuns[0]?.runId, "run-2");
  assert.equal(skipLog.meta?.newerRuns[0]?.sessionKey, "agent:main:slack:channel:c123");
  assert.equal(skipLog.meta?.newerRuns[0]?.startSequence, 2);
  assert.equal(skipLog.meta?.newerRuns[0]?.active, false);
  assert.equal(skipLog.meta?.newerRuns[0]?.trigger, "user");
  assert.equal(skipLog.meta?.newerRuns[0]?.source, "before_model_resolve");
  assert.ok(typeof skipLog.meta?.newerRuns[0]?.startedAt === "number");
  assert.ok(typeof skipLog.meta?.newerRuns[0]?.endedAt === "number");
});

test("debug_logs emits prefixed step logs when enabled", async () => {
  const { api, hooks, logs } = createMockApi({ enabled: true, debug_logs: true });

  registerKeepGoingPlugin(api, {
    validateContinuationWithLlm: async () => ({
      continue: false,
      reason: "already complete",
      validatorModel: "gpt-5.4-mini",
    }),
    launchContinuation: async () => ({ followUpRunId: "follow-up-1" }),
  });

  const beforeModelResolve = hooks.get("before_model_resolve");
  const agentEnd = hooks.get("agent_end");
  const runContext = createRunContext();

  await beforeModelResolve?.({ prompt: "Please continue the task." }, runContext);
  await agentEnd?.(
    {
      success: true,
      messages: [],
    },
    runContext,
  );

  assert.ok(logs.info.length > 0);
  assert.ok(logs.info.every((entry) => entry.message.startsWith("Keep-Going Plugin: ")));
  assert.ok(
    logs.info.some(
      (entry) => entry.message === "Keep-Going Plugin: agent_end received",
    ),
  );
  assert.ok(
    logs.info.some(
      (entry) => entry.message === "Keep-Going Plugin: validator completed",
    ),
  );
});

test("debug_logs suppresses step logs when disabled", async () => {
  const { api, hooks, logs } = createMockApi({ enabled: true, debug_logs: false });

  registerKeepGoingPlugin(api, {
    validateContinuationWithLlm: async () => ({
      continue: false,
      reason: "already complete",
      validatorModel: "gpt-5.4-mini",
    }),
    launchContinuation: async () => ({ followUpRunId: "follow-up-1" }),
  });

  const beforeModelResolve = hooks.get("before_model_resolve");
  const agentEnd = hooks.get("agent_end");
  const runContext = createRunContext();

  await beforeModelResolve?.({ prompt: "Please continue the task." }, runContext);
  await agentEnd?.(
    {
      success: true,
      messages: [],
    },
    runContext,
  );

  assert.equal(logs.info.length, 0);
  assert.equal(logs.error.length, 0);
});

test("errors still log with prefix when debug_logs is disabled", async () => {
  const { api, hooks, logs } = createMockApi({ enabled: true, debug_logs: false });

  registerKeepGoingPlugin(api, {
    validateContinuationWithLlm: async () => {
      throw new Error("boom");
    },
    launchContinuation: async () => ({ followUpRunId: "follow-up-1" }),
  });

  const agentEnd = hooks.get("agent_end");

  await agentEnd?.(
    {
      success: true,
      messages: [],
    },
    createRunContext(),
  );

  assert.equal(logs.info.length, 0);
  assert.equal(logs.error.length, 1);
  assert.ok(logs.error[0]?.message.startsWith("Keep-Going Plugin: "));
  assert.equal(logs.error[0]?.message, "Keep-Going Plugin: llm validator failed");
});
