import test from "node:test";
import assert from "node:assert/strict";
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

test("extract human-facing final turn messages skip control text and synthetic continuation prompts", () => {
  const userText = extractLastUserHumanFacingText([
    { role: "user", content: "Continue the previous task." },
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
