import test from "node:test";
import assert from "node:assert/strict";
import { buildValidatorPrompt } from "../src/llm-validator.js";
import {
  extractInitialSlackThreadHistoryMessages,
  extractLastAssistantHumanFacingText,
  extractLastAssistantText,
  extractLastUserHumanFacingText,
  extractSlackThreadHistoryMessages,
  normalizeHumanFacingUserText,
  normalizeTranscriptMessages,
} from "../src/messages.js";
import { resolveContinuationSessionFile } from "../src/launcher.js";
import { resolveSessionRoute } from "../src/session-route.js";
import type { ContinuationCandidate, KeepGoingLlmValidatorConfig } from "../src/types.js";
import { readSampleSessionStore, readSampleTranscriptMessages } from "./fixtures.js";

const SLACK_SESSION_FILE = "29a2c708-ff8a-4e05-a48e-50746cd16979-topic-1775853170.228819.jsonl";
const SLACK_SESSION_ID = "29a2c708-ff8a-4e05-a48e-50746cd16979";
const SLACK_SESSION_KEY = "agent:main:slack:channel:c0apws0e3s8:thread:1775853170.228819";

function createMockApi(store: Record<string, unknown>) {
  return {
    config: {
      session: {
        store: "/virtual/sessions.json",
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
    workspaceDir: "/Users/billjohansson/clawd",
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
  return {
    provider: "openai",
    model: "gpt-5.4-mini",
    apiKeyEnv: "KEEP_GOING_OPENAI_API_KEY",
    maxMessages: 20,
    maxChars: 20_000,
    includeCurrentTurnOnly: true,
    recentUserMessages: 3,
    temperature: 0,
    timeoutMs: 15_000,
    ...overrides,
  };
}

test("resolveSessionRoute reconstructs a real Slack thread route from sessions.json", () => {
  const store = readSampleSessionStore();
  const api = createMockApi(store);

  const route = resolveSessionRoute(api as never, {
    agentId: "main",
    sessionKey: SLACK_SESSION_KEY,
  });

  assert.equal(route.lookupStatus, "ok");
  assert.equal(route.isSlack, true);
  assert.equal(route.channel, "slack");
  assert.equal(route.to, "channel:C0APWS0E3S8");
  assert.equal(route.accountId, "default");
  assert.equal(route.threadId, "1775853170.228819");
  assert.equal(route.sessionFile, "/Users/pearlperelel/.openclaw/agents/main/sessions/29a2c708-ff8a-4e05-a48e-50746cd16979-topic-1775853170.228819.jsonl");
  assert.equal(route.modelProviderId, "openai-codex");
  assert.equal(route.modelId, "gpt-5.4");
  assert.equal(route.authProfileId, "openai-codex:pearl@perelelhealth.com");
});

test("resolveContinuationSessionFile preserves the existing Slack session transcript file", () => {
  const store = readSampleSessionStore();
  const api = createMockApi(store);
  const route = resolveSessionRoute(api as never, {
    agentId: "main",
    sessionKey: SLACK_SESSION_KEY,
  });

  assert.equal(route.lookupStatus, "ok");

  const sessionFile = resolveContinuationSessionFile(api as never, {
    candidate: createCandidate([]),
    sessionRoute: route,
  });

  assert.equal(
    sessionFile,
    "/Users/pearlperelel/.openclaw/agents/main/sessions/29a2c708-ff8a-4e05-a48e-50746cd16979-topic-1775853170.228819.jsonl",
  );
});

test("real Slack transcript normalizes to user-facing messages and tool events", () => {
  const messages = readSampleTranscriptMessages(SLACK_SESSION_FILE);
  const transcript = normalizeTranscriptMessages(messages);

  assert.ok(transcript.length > 0);
  assert.equal(transcript[0]?.role, "user");
  assert.match(transcript[0]?.text ?? "", /solid work on the pacing cron/i);
  assert.ok(
    transcript.some(
      (entry) =>
        entry.role === "assistant" && entry.text.includes("[Tool Call: read]"),
    ),
  );
  assert.ok(
    transcript.some(
      (entry) =>
        entry.role === "assistant" && entry.text.includes("[[reply_to_current]]"),
    ),
  );
});

test("validator prompt with current-turn-only excludes earlier turns from the same Slack thread", () => {
  const messages = readSampleTranscriptMessages(SLACK_SESSION_FILE);
  const candidate = createCandidate(messages);
  const normalized = normalizeTranscriptMessages(messages);
  const currentTurnStart = normalized.findLastIndex(
    (entry) =>
      entry.role === "user" &&
      entry.text.includes("Send a subagent to investigate the cron itself"),
  );

  assert.notEqual(currentTurnStart, -1);

  const currentTurnTranscript = normalized.slice(currentTurnStart);
  const prompt = buildValidatorPrompt({
    candidate,
    config: createValidatorConfig({ includeCurrentTurnOnly: true }),
    context: {
      runTranscriptMessages: currentTurnTranscript,
    },
  });

  assert.match(prompt, /Conversation scope: current work plus up to 3 recent user turns/);
  assert.match(prompt, /Send a subagent to investigate the cron itself/i);
  assert.doesNotMatch(prompt, /are you sure\?/i);
});

test("validator prompt can include up to the last three user turns from session history", () => {
  const candidate = createCandidate([]);
  const sessionTranscript = [
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
    "System: [2026-04-10 10:19:39 EDT] Slack message in #pearl-maddie from Bek Akhmedov: Analyze teh logs, why did it die mid run that makes no sense",
    "",
    "Conversation info (untrusted metadata):",
    "```json",
    "{\"message_id\":\"1775830778.192859\"}",
    "```",
    "",
    "Sender (untrusted metadata):",
    "```json",
    "{\"label\":\"Bek Akhmedov (U0AJTJTKAMD)\"}",
    "```",
    "",
    "Analyze teh logs, why did it die mid run that makes no sense",
  ].join("\n"));

  assert.equal(cleaned, "Analyze teh logs, why did it die mid run that makes no sense");
});

test("extract human-facing final turn messages skips control text and synthetic continuation prompts", () => {
  const userText = extractLastUserHumanFacingText([
    { role: "user", content: "Continue the previous task." },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: [
            "System: [2026-04-10 16:39:22 EDT] Slack message in #pearl-maddie from Bek Akhmedov: Okay, can you first have a subagent summarize the truth from that convo, and then update your memory",
            "",
            "Conversation info (untrusted metadata):",
            "```json",
            "{\"message_id\":\"1775853561.292839\"}",
            "```",
            "",
            "Sender (untrusted metadata):",
            "```json",
            "{\"label\":\"Bek Akhmedov (U0AJTJTKAMD)\"}",
            "```",
            "",
            "Okay, can you first have a subagent summarize the truth from that convo, and then update your memory",
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

  assert.equal(
    userText,
    "Okay, can you first have a subagent summarize the truth from that convo, and then update your memory",
  );
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
    "[Slack Bek Akhmedov (user) Fri 2026-04-10 16:32 EDT] Root user request",
    "[slack message id: 1775853170.228819 channel: C0APWS0E3S8]",
    "",
    "[Slack Pearl (assistant) Fri 2026-04-10 16:33 EDT] First assistant reply",
    "[slack message id: 1775853235.857849 channel: C0APWS0E3S8]",
    "",
    "[Slack Pearl (assistant) Fri 2026-04-10 16:33 EDT] Second assistant reply",
    "[slack message id: 1775853235.997439 channel: C0APWS0E3S8]",
    "",
    "System: [2026-04-10 16:38:05 EDT] Slack message in #pearl-maddie from Bek Akhmedov: are you sure?",
  ].join("\n"));

  assert.deepEqual(messages, [
    { type: "user", msg: "Root user request" },
    { type: "assistant", msg: "First assistant reply" },
    { type: "assistant", msg: "Second assistant reply" },
  ]);
});

test("extractInitialSlackThreadHistoryMessages returns the first embedded thread history from transcript messages", () => {
  const history = extractInitialSlackThreadHistoryMessages([
    {
      role: "user",
      content: [
        {
          type: "text",
          text: [
            "[Thread history - for context]",
            "[Slack Pearl (assistant) Fri 2026-04-10 09:49 EDT] Initial assistant post",
            "[slack message id: 1775828941.576599 channel: C0APWS0E3S8]",
            "",
            "System: [2026-04-10 10:18:00 EDT] Slack message in #pearl-maddie from Bek Akhmedov: what failed here?",
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

  assert.deepEqual(history, [
    { type: "assistant", msg: "Initial assistant post" },
  ]);
});
