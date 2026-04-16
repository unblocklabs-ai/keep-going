import test from "node:test";
import assert from "node:assert/strict";
import type { OpenClawPluginApi, RuntimeLogger } from "openclaw/plugin-sdk";
import { registerKeepGoingPlugin } from "../src/plugin.js";
import type { ContinuationValidationContext } from "../src/types.js";

const SESSION_KEY = "agent:main:slack:channel:c123:thread:1712345678.000100";
const SESSION_FILE = "/virtual/session.jsonl";

type MockLoggerCall = {
  message: string;
  meta?: Record<string, unknown>;
};

function createMockApi(pluginConfig: Record<string, unknown> = { enabled: true }) {
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
    },
    runtime: {
      logging: {
        getChildLogger: () => logger,
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
        runEmbeddedPiAgent: async () => {
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
