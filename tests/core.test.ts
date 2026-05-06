import test from "node:test";
import assert from "node:assert/strict";
import {
  KEEP_GOING_SYNTHETIC_WAKE_PREFIX,
  OPENCLAW_RUNTIME_EVENT_USER_PROMPT,
} from "../src/constants.js";
import { resolveKeepGoingConfig } from "../src/config.js";
import { buildValidatorPrompt } from "../src/llm-validator.js";
import {
  resolveContinuationSessionFile,
  type SessionFileResolverApi,
} from "../src/launcher.js";
import {
  extractInitialSlackThreadHistoryMessages,
  extractLastAssistantHumanFacingText,
  extractLastAssistantText,
  extractLastUserHumanFacingText,
  extractSlackThreadHistoryMessages,
  normalizeHumanFacingUserText,
  normalizeTranscriptMessages,
} from "../src/messages.js";
import { resolveLlmApiKey } from "../src/openai-api-key.js";
import { createDefaultOpenAiValidatorConfig } from "../src/openai-validator-config.js";
import { SessionActivityTracker } from "../src/session-activity.js";
import { resolveSessionRoute, type SessionRouteApi } from "../src/session-route.js";
import type { TranscriptMessage } from "../src/transcript-types.js";
import type { ContinuationCandidate, KeepGoingLlmValidatorConfig } from "../src/types.js";

const SLACK_SESSION_ID = "session-1";
const SLACK_SESSION_KEY = "agent:main:slack:channel:c123:thread:1712345678.000100";
const SLACK_SESSION_FILE =
  "/Users/example/.openclaw/agents/main/sessions/session-1-topic-1712345678.000100.jsonl";

type SessionStore = ReturnType<
  SessionRouteApi["runtime"]["agent"]["session"]["loadSessionStore"]
>;

function createMockApi(store: SessionStore): SessionRouteApi & SessionFileResolverApi {
  return {
    config: {
      session: {
        store: "/virtual/sessions.json",
      },
      channels: {
        slack: {
          replyToMode: "first",
        },
      },
    },
    runtime: {
      agent: {
        session: {
          resolveStorePath: () => "/virtual/sessions.json",
          loadSessionStore: () => store,
          resolveSessionFilePath: (sessionId: string, options?: { sessionFile?: string }) =>
            options?.sessionFile ?? `/virtual/${sessionId}.jsonl`,
        },
      },
    },
  };
}

function createCandidate(messages: unknown[]): ContinuationCandidate {
  return {
    runId: "fixture-run-id",
    agentId: "main",
    sessionId: SLACK_SESSION_ID,
    sessionKey: SLACK_SESSION_KEY,
    workspaceDir: "/workspace",
    modelProviderId: "openai-codex",
    modelId: "gpt-5.4",
    success: true,
    trigger: "message",
    messages,
  };
}

function createValidatorConfig(
  overrides?: Partial<KeepGoingLlmValidatorConfig>,
): KeepGoingLlmValidatorConfig {
  return createDefaultOpenAiValidatorConfig(overrides);
}

test("resolveSessionRoute reconstructs Slack delivery and auth fields", () => {
  const store = {
    [SLACK_SESSION_KEY]: {
      sessionFile: SLACK_SESSION_FILE,
      deliveryContext: {
        channel: "slack",
        to: "channel:C123",
        accountId: "default",
        threadId: "1712345678.000100",
      },
      modelProvider: "openai-codex",
      model: "gpt-5.4",
      authProfileOverride: "openai-codex:user@example.com",
    },
  };

  const route = resolveSessionRoute(createMockApi(store), {
    agentId: "main",
    sessionKey: SLACK_SESSION_KEY,
  });

  assert.equal(route.lookupStatus, "ok");
  assert.equal(route.isSlack, true);
  assert.equal(route.channel, "slack");
  assert.equal(route.to, "channel:C123");
  assert.equal(route.accountId, "default");
  assert.equal(route.threadId, "1712345678.000100");
  assert.equal(route.currentChannelId, "C123");
  assert.equal(route.replyToMode, "first");
  assert.equal(route.sessionFile, SLACK_SESSION_FILE);
  assert.equal(route.modelProviderId, "openai-codex");
  assert.equal(route.modelId, "gpt-5.4");
  assert.equal(route.authProfileId, "openai-codex:user@example.com");
});

test("resolveContinuationSessionFile preserves the existing session transcript file", () => {
  const route = resolveSessionRoute(
    createMockApi({
      [SLACK_SESSION_KEY]: {
        sessionFile: SLACK_SESSION_FILE,
        deliveryContext: {
          channel: "slack",
        },
      },
    }),
    {
      agentId: "main",
      sessionKey: SLACK_SESSION_KEY,
    },
  );

  assert.equal(route.lookupStatus, "ok");

  const sessionFile = resolveContinuationSessionFile(createMockApi({}), {
    candidate: createCandidate([]),
    sessionRoute: route,
  });

  assert.equal(sessionFile, SLACK_SESSION_FILE);
});

test("shared default validator config matches runtime plugin defaults", () => {
  assert.deepEqual(
    resolveKeepGoingConfig({}).validator.llm,
    createDefaultOpenAiValidatorConfig(),
  );
});

test("validator API key resolution prefers SecretRef over inline and env", async () => {
  const previousOpenAi = process.env.OPENAI_API_KEY;
  const previousKeepGoing = process.env.KEEP_GOING_OPENAI_API_KEY;
  const previousSecretRef = process.env.KEEP_GOING_SECRET_REF_KEY;
  try {
    process.env.OPENAI_API_KEY = "shared-openai-key";
    process.env.KEEP_GOING_OPENAI_API_KEY = "plugin-openai-key";
    process.env.KEEP_GOING_SECRET_REF_KEY = "secret-ref-openai-key";

    assert.equal(
      await resolveLlmApiKey(
        createDefaultOpenAiValidatorConfig({
          apiKeyRef: {
            source: "env",
            provider: "local",
            id: "KEEP_GOING_SECRET_REF_KEY",
          },
          apiKey: "inline-openai-key",
        }),
        {
          secrets: {
            providers: {
              local: {
                source: "env",
              },
            },
          },
        },
      ),
      "secret-ref-openai-key",
    );
  } finally {
    if (previousOpenAi === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousOpenAi;
    }
    if (previousKeepGoing === undefined) {
      delete process.env.KEEP_GOING_OPENAI_API_KEY;
    } else {
      process.env.KEEP_GOING_OPENAI_API_KEY = previousKeepGoing;
    }
    if (previousSecretRef === undefined) {
      delete process.env.KEEP_GOING_SECRET_REF_KEY;
    } else {
      process.env.KEEP_GOING_SECRET_REF_KEY = previousSecretRef;
    }
  }
});

test("validator API key resolution preserves SecretRef through plugin config normalization", async () => {
  const previousSecretRef = process.env.KEEP_GOING_SECRET_REF_KEY;
  try {
    process.env.KEEP_GOING_SECRET_REF_KEY = "normalized-secret-ref-openai-key";

    const config = resolveKeepGoingConfig({
      validator: {
        llm: {
          apiKeyRef: {
            source: "env",
            provider: "local",
            id: "KEEP_GOING_SECRET_REF_KEY",
          },
          apiKey: "inline-openai-key",
        },
      },
    });

    assert.deepEqual(config.validator.llm.apiKeyRef, {
      source: "env",
      provider: "local",
      id: "KEEP_GOING_SECRET_REF_KEY",
    });
    assert.equal(
      await resolveLlmApiKey(config.validator.llm, {
        secrets: {
          providers: {
            local: {
              source: "env",
            },
          },
        },
      }),
      "normalized-secret-ref-openai-key",
    );
  } finally {
    if (previousSecretRef === undefined) {
      delete process.env.KEEP_GOING_SECRET_REF_KEY;
    } else {
      process.env.KEEP_GOING_SECRET_REF_KEY = previousSecretRef;
    }
  }
});

test("failed validator API key SecretRef warning does not expose fallback secret values", async () => {
  const previousOpenAi = process.env.OPENAI_API_KEY;
  const warnings: Array<{ message: string; meta?: Record<string, unknown> }> = [];
  try {
    process.env.OPENAI_API_KEY = "shared-openai-key-that-must-not-be-logged";

    const apiKey = await resolveLlmApiKey(
      createDefaultOpenAiValidatorConfig({
        apiKeyRef: {
          source: "env",
          provider: "local",
          id: "MISSING_KEEP_GOING_SECRET_REF_KEY",
        },
      }),
      {
        secrets: {
          providers: {
            local: {
              source: "env",
            },
          },
        },
      },
      {
        logger: {
          warn: (message, meta) => warnings.push({ message, meta }),
        },
      },
    );

    assert.equal(apiKey, "shared-openai-key-that-must-not-be-logged");
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]?.message, "validator API key SecretRef could not be resolved");
    assert.equal(
      warnings[0]?.meta?.path,
      "plugins.entries.keep-going.config.validator.llm.apiKeyRef",
    );
    assert.equal(warnings[0]?.meta?.source, "env");
    assert.equal(warnings[0]?.meta?.provider, "local");
    assert.equal(warnings[0]?.meta?.id, "MISSING_KEEP_GOING_SECRET_REF_KEY");
    assert.equal(
      JSON.stringify(warnings).includes("shared-openai-key-that-must-not-be-logged"),
      false,
    );
  } finally {
    if (previousOpenAi === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousOpenAi;
    }
  }
});

test("validator API key resolution falls back to shared OpenAI env", async () => {
  const previousOpenAi = process.env.OPENAI_API_KEY;
  const previousKeepGoing = process.env.KEEP_GOING_OPENAI_API_KEY;
  try {
    delete process.env.KEEP_GOING_OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "shared-openai-key";

    assert.equal(
      await resolveLlmApiKey(createDefaultOpenAiValidatorConfig()),
      "shared-openai-key",
    );
  } finally {
    if (previousOpenAi === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousOpenAi;
    }
    if (previousKeepGoing === undefined) {
      delete process.env.KEEP_GOING_OPENAI_API_KEY;
    } else {
      process.env.KEEP_GOING_OPENAI_API_KEY = previousKeepGoing;
    }
  }
});

test("validator API key resolution prefers plugin-specific override env", async () => {
  const previousOpenAi = process.env.OPENAI_API_KEY;
  const previousKeepGoing = process.env.KEEP_GOING_OPENAI_API_KEY;
  try {
    process.env.OPENAI_API_KEY = "shared-openai-key";
    process.env.KEEP_GOING_OPENAI_API_KEY = "plugin-openai-key";

    assert.equal(
      await resolveLlmApiKey(createDefaultOpenAiValidatorConfig()),
      "plugin-openai-key",
    );
  } finally {
    if (previousOpenAi === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousOpenAi;
    }
    if (previousKeepGoing === undefined) {
      delete process.env.KEEP_GOING_OPENAI_API_KEY;
    } else {
      process.env.KEEP_GOING_OPENAI_API_KEY = previousKeepGoing;
    }
  }
});

test("validator API key resolution prefers inline override", async () => {
  const previousOpenAi = process.env.OPENAI_API_KEY;
  const previousKeepGoing = process.env.KEEP_GOING_OPENAI_API_KEY;
  try {
    process.env.OPENAI_API_KEY = "shared-openai-key";
    process.env.KEEP_GOING_OPENAI_API_KEY = "plugin-openai-key";

    assert.equal(
      await resolveLlmApiKey(createDefaultOpenAiValidatorConfig({ apiKey: "inline-openai-key" })),
      "inline-openai-key",
    );
  } finally {
    if (previousOpenAi === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousOpenAi;
    }
    if (previousKeepGoing === undefined) {
      delete process.env.KEEP_GOING_OPENAI_API_KEY;
    } else {
      process.env.KEEP_GOING_OPENAI_API_KEY = previousKeepGoing;
    }
  }
});

test("validator API key resolution uses OpenClaw config env before process env", async () => {
  const previousOpenAi = process.env.OPENAI_API_KEY;
  const previousKeepGoing = process.env.KEEP_GOING_OPENAI_API_KEY;
  try {
    process.env.OPENAI_API_KEY = "process-shared-openai-key";
    process.env.KEEP_GOING_OPENAI_API_KEY = "process-plugin-openai-key";

    assert.equal(
      await resolveLlmApiKey(createDefaultOpenAiValidatorConfig(), {
        env: {
          vars: {
            KEEP_GOING_OPENAI_API_KEY: "config-plugin-openai-key",
            OPENAI_API_KEY: "config-shared-openai-key",
          },
        },
      }),
      "config-plugin-openai-key",
    );
  } finally {
    if (previousOpenAi === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousOpenAi;
    }
    if (previousKeepGoing === undefined) {
      delete process.env.KEEP_GOING_OPENAI_API_KEY;
    } else {
      process.env.KEEP_GOING_OPENAI_API_KEY = previousKeepGoing;
    }
  }
});

test("validator API key resolution falls back to resolved OpenClaw provider key", async () => {
  const previousOpenAi = process.env.OPENAI_API_KEY;
  const previousKeepGoing = process.env.KEEP_GOING_OPENAI_API_KEY;
  try {
    delete process.env.OPENAI_API_KEY;
    delete process.env.KEEP_GOING_OPENAI_API_KEY;

    assert.equal(
      await resolveLlmApiKey(createDefaultOpenAiValidatorConfig(), {
        models: {
          providers: {
            openai: {
              apiKey: "resolved-provider-openai-key",
            },
          },
        },
      }),
      "resolved-provider-openai-key",
    );
  } finally {
    if (previousOpenAi === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousOpenAi;
    }
    if (previousKeepGoing === undefined) {
      delete process.env.KEEP_GOING_OPENAI_API_KEY;
    } else {
      process.env.KEEP_GOING_OPENAI_API_KEY = previousKeepGoing;
    }
  }
});

test("continuation reaction config defaults enabled", () => {
  assert.deepEqual(resolveKeepGoingConfig({}).continuationReaction, {
    enabled: true,
  });
});

test("continuation reaction config supports disabled", () => {
  assert.deepEqual(
    resolveKeepGoingConfig({
      continuationReaction: {
        enabled: false,
      },
    }).continuationReaction,
    {
      enabled: false,
    },
  );
});

test("legacy user-facing notice disabled config disables continuation reaction by default", () => {
  assert.deepEqual(
    resolveKeepGoingConfig({
      userFacingNotice: {
        enabled: false,
        text: "Taking another pass.",
      },
    }).continuationReaction,
    {
      enabled: false,
    },
  );
});

test("continuation reaction config overrides legacy user-facing notice config", () => {
  assert.deepEqual(
    resolveKeepGoingConfig({
      continuationReaction: {
        enabled: true,
      },
      userFacingNotice: {
        enabled: false,
      },
    }).continuationReaction,
    {
      enabled: true,
    },
  );
});

test("continuation notice config defaults to fallback only", () => {
  assert.deepEqual(resolveKeepGoingConfig({}).continuationNotice, {
    mode: "fallbackOnly",
    text: ":eyes: continuing...",
  });
});

test("continuation notice config supports off and custom text", () => {
  assert.deepEqual(
    resolveKeepGoingConfig({
      continuationNotice: {
        mode: "off",
        text: "Continuing.",
      },
    }).continuationNotice,
    {
      mode: "off",
      text: "Continuing.",
    },
  );
});

test("validator prompt can include up to the last three user turns from session history", () => {
  const candidate = createCandidate([]);
  const sessionTranscript: TranscriptMessage[] = [
    { role: "user", text: "first request that should be excluded" },
    { role: "assistant", text: "ack first request" },
    { role: "user", text: "second request: build a bridge" },
    { role: "assistant", text: "[Tool Call: read]\n\ndrafted bridge design" },
    { role: "user", text: "third request: make it steel" },
    { role: "assistant", text: "updated the materials" },
    { role: "user", text: "fourth request: actually finish the bridge" },
    { role: "assistant", text: "I finished the design only." },
    { role: "toolResult", text: "[Tool Result]\nbridge sketch loaded" },
    { role: "assistant", text: "[Tool Call: write]\n\nStill only the design is complete." },
  ];

  const prompt = buildValidatorPrompt({
    candidate,
    config: createValidatorConfig({
      maxMessages: 20,
      recentUserMessages: 3,
    }),
    context: {
      runTranscriptMessages: sessionTranscript.slice(-4),
      sessionTranscriptMessages: sessionTranscript,
    },
  });

  assert.match(prompt, /second request: build a bridge/i);
  assert.match(prompt, /third request: make it steel/i);
  assert.match(prompt, /fourth request: actually finish the bridge/i);
  assert.match(prompt, /drafted bridge design/i);
  assert.match(prompt, /\[Tool Call: write\]/i);
  assert.doesNotMatch(prompt, /\[Tool Call: read\]/i);
  assert.doesNotMatch(prompt, /first request that should be excluded/i);
});

test("normalizeTranscriptMessages skips assistant NO_REPLY content", () => {
  const transcript = normalizeTranscriptMessages([
    { role: "assistant", content: "NO_REPLY" },
    { role: "assistant", content: [{ type: "output_text", text: "Done investigating." }] },
    { role: "assistant", content: [{ type: "output_text", text: "NO_REPLY" }] },
    { role: "assistant", tool_calls: [{ function: { name: "read" } }] },
  ]);

  assert.deepEqual(transcript, [
    { role: "assistant", text: "Done investigating." },
    { role: "assistant", text: "[Tool Call: read]" },
  ]);
});

test("normalizeTranscriptMessages skips synthetic continuation wake prompts", () => {
  const transcript = normalizeTranscriptMessages([
    {
      role: "user",
      content: [
        KEEP_GOING_SYNTHETIC_WAKE_PREFIX,
        "Your previous turn likely ended early while actionable work still remained.",
        "Resume the same task now.",
        'Reminder: for a visible, non-turn-terminating update, use `message(action="send", ...)` and then keep working in the same turn.',
        "Only use a normal assistant reply when you intend to end your turn.",
        "If you are blocked, state the exact blocker briefly. If already complete, reply `NO_REPLY`.",
        "Recommended next step: Patch the worker and verify it.",
      ].join("\n"),
    },
    { role: "user", content: OPENCLAW_RUNTIME_EVENT_USER_PROMPT },
    { role: "user", content: "Continue the previous task." },
    { role: "user", content: "Real user follow-up" },
  ]);

  assert.deepEqual(transcript, [{ role: "user", text: "Real user follow-up" }]);
});

test("extractLastAssistantText ignores trailing assistant NO_REPLY messages", () => {
  const lastAssistantText = extractLastAssistantText([
    { role: "assistant", content: [{ type: "output_text", text: "Completed the audit." }] },
    { role: "assistant", content: "NO_REPLY" },
  ]);

  assert.equal(lastAssistantText, "Completed the audit.");
});

test("normalizeHumanFacingUserText strips Slack wrapper metadata", () => {
  const cleaned = normalizeHumanFacingUserText([
    "System: [2026-04-10 10:19:39 EDT] Slack message in #ops from Bek: Analyze the logs",
    "",
    "Conversation info (untrusted metadata):",
    "```json",
    "{\"message_id\":\"1775830778.192859\"}",
    "```",
    "",
    "Sender (untrusted metadata):",
    "```json",
    "{\"label\":\"Bek (U123)\"}",
    "```",
    "",
    "Analyze the logs",
  ].join("\n"));

  assert.equal(cleaned, "Analyze the logs");
});

test("clearRun removes stale active replay state for the same run id", () => {
  const tracker = new SessionActivityTracker();

  tracker.markRunStarted({
    sessionKey: SLACK_SESSION_KEY,
    runId: "run-1",
    trigger: "message",
    source: "before_model_resolve",
  });
  tracker.markRunEnded({
    sessionKey: SLACK_SESSION_KEY,
    runId: "run-1",
  });

  tracker.markRunStarted({
    sessionKey: SLACK_SESSION_KEY,
    runId: "run-1",
    trigger: "message",
    source: "before_model_resolve",
  });
  tracker.clearRun("run-1");

  tracker.recordTranscriptUpdate({
    sessionFile: SLACK_SESSION_FILE,
    sessionKey: SLACK_SESSION_KEY,
    messageId: "assistant-msg-1",
    message: {
      role: "assistant",
      content: [{ type: "output_text", text: "cleanup finished" }],
    },
  });

  assert.deepEqual(tracker.getRunTranscriptMessages("run-1"), []);
  assert.deepEqual(
    tracker.getRunsStartedAfter({
      sessionKey: SLACK_SESSION_KEY,
      after: { lastStartSequence: 0 },
      ignoreRunIds: [],
    }),
    [],
  );
});

test("session activity tracker does not persist synthetic continuation wake prompts", () => {
  const tracker = new SessionActivityTracker();

  tracker.markRunStarted({
    sessionKey: SLACK_SESSION_KEY,
    runId: "run-1",
    trigger: "manual",
    source: "test",
  });

  tracker.recordTranscriptUpdate({
    sessionFile: SLACK_SESSION_FILE,
    sessionKey: SLACK_SESSION_KEY,
    messageId: "wake-msg-1",
    message: {
      role: "user",
      content: [
        {
          type: "input_text",
          text: [
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
            "Validator-suggested next step: Patch the worker and verify it.",
          ].join("\n"),
        },
      ],
    },
  });

  tracker.recordTranscriptUpdate({
    sessionFile: SLACK_SESSION_FILE,
    sessionKey: SLACK_SESSION_KEY,
    messageId: "user-msg-2",
    message: {
      role: "user",
      content: [{ type: "input_text", text: "Real user follow-up" }],
    },
  });

  assert.deepEqual(tracker.getRunTranscriptMessages("run-1"), [
    { role: "user", text: "Real user follow-up" },
  ]);
  assert.deepEqual(tracker.getSessionTranscriptMessages(SLACK_SESSION_KEY), [
    { role: "user", text: "Real user follow-up" },
  ]);
});

test("session activity tracker records the latest assistant message id", () => {
  const tracker = new SessionActivityTracker();

  tracker.markRunStarted({
    sessionKey: SLACK_SESSION_KEY,
    runId: "run-1",
    trigger: "manual",
    source: "test",
  });

  tracker.recordTranscriptUpdate({
    sessionFile: SLACK_SESSION_FILE,
    sessionKey: SLACK_SESSION_KEY,
    messageId: "assistant-msg-1",
    message: {
      role: "assistant",
      content: [{ type: "output_text", text: "First assistant message" }],
    },
  });

  tracker.recordTranscriptUpdate({
    sessionFile: SLACK_SESSION_FILE,
    sessionKey: SLACK_SESSION_KEY,
    messageId: "assistant-msg-2",
    message: {
      role: "assistant",
      content: [{ type: "output_text", text: "Real assistant work" }],
    },
  });

  assert.equal(
    tracker.getLatestAssistantMessageId({
      sessionKey: SLACK_SESSION_KEY,
      sessionFile: SLACK_SESSION_FILE,
    }),
    "assistant-msg-2",
  );
});

test("extract human-facing final turn messages skip control text and synthetic continuation prompts", () => {
  const userText = extractLastUserHumanFacingText([
    {
      role: "user",
      content: [
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
        "Validator-suggested next step: Patch the worker and verify it.",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: [
            "System: [2026-04-10 16:39:22 EDT] Slack message in #ops from Bek: Fix the worker",
            "",
            "Conversation info (untrusted metadata):",
            "```json",
            "{\"message_id\":\"1775853561.292839\"}",
            "```",
            "",
            "Sender (untrusted metadata):",
            "```json",
            "{\"label\":\"Bek (U123)\"}",
            "```",
            "",
            "Fix the worker",
          ].join("\n"),
        },
      ],
    },
  ]);
  const assistantText = extractLastAssistantHumanFacingText([
    { role: "assistant", tool_calls: [{ function: { name: "read" } }] },
    {
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: "[[reply_to_current]] The audit is complete.",
        },
      ],
    },
  ]);

  assert.equal(userText, "Fix the worker");
  assert.equal(assistantText, "The audit is complete.");
});

test("normalizeHumanFacingUserText skips internal runtime wake-up messages", () => {
  assert.equal(normalizeHumanFacingUserText(OPENCLAW_RUNTIME_EVENT_USER_PROMPT), undefined);

  const cleaned = normalizeHumanFacingUserText([
    "[Fri 2026-04-10 16:40 EDT] <<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
    "OpenClaw runtime context (internal):",
    "[Internal task completion event]",
    "source: subagent",
  ].join("\n"));

  assert.equal(cleaned, undefined);
});

test("extractSlackThreadHistoryMessages parses embedded Slack history entries", () => {
  const messages = extractSlackThreadHistoryMessages([
    "[Thread history - for context]",
    "[Slack Bek (user) Fri 2026-04-10 16:32 EDT] Root user request",
    "[slack message id: 1775853170.228819 channel: C123]",
    "",
    "[Slack Pearl (assistant) Fri 2026-04-10 16:33 EDT] First assistant reply",
    "[slack message id: 1775853235.857849 channel: C123]",
    "",
    "[Slack Pearl (assistant) Fri 2026-04-10 16:33 EDT] Second assistant reply",
    "[slack message id: 1775853235.997439 channel: C123]",
    "",
    "System: [2026-04-10 16:38:05 EDT] Slack message in #ops from Bek: are you sure?",
  ].join("\n"));

  assert.deepEqual(messages, [
    { type: "user", msg: "Root user request" },
    { type: "assistant", msg: "First assistant reply" },
    { type: "assistant", msg: "Second assistant reply" },
  ]);
});

test("extractInitialSlackThreadHistoryMessages returns the first embedded thread history", () => {
  const history = extractInitialSlackThreadHistoryMessages([
    {
      role: "user",
      content: [
        {
          type: "text",
          text: [
            "[Thread history - for context]",
            "[Slack Pearl (assistant) Fri 2026-04-10 09:49 EDT] Initial assistant post",
            "[slack message id: 1775828941.576599 channel: C123]",
            "",
            "System: [2026-04-10 10:18:00 EDT] Slack message in #ops from Bek: what failed here?",
            "",
            "what failed here?",
          ].join("\n"),
        },
      ],
    },
    {
      role: "assistant",
      content: [{ type: "output_text", text: "[[reply_to_current]] The guarded failure was..." }],
    },
  ]);

  assert.deepEqual(history, [{ type: "assistant", msg: "Initial assistant post" }]);
});
