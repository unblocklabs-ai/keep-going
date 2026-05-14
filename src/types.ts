import type { TranscriptMessage } from "./transcript-types.js";
import type { SecretRef } from "openclaw/plugin-sdk/secret-ref-runtime";

export type SlackReplyToMode = "off" | "first" | "all" | "batched";

export type OpenAiLlmCallConfig = {
  provider: "openai";
  model: string;
  apiKeyRef?: SecretRef;
  apiKey?: string;
  apiKeyEnv?: string;
  temperature?: number;
  timeoutMs?: number;
};

export type KeepGoingLlmValidatorConfig = OpenAiLlmCallConfig & {
  systemPrompt: string;
  maxMessages: number;
  maxChars: number;
  includeCurrentTurnOnly: boolean;
  recentUserMessages: number;
};

export type KeepGoingPluginConfig = {
  enabled: boolean;
  debug_logs: boolean;
  channels: string[];
  timeoutMs?: number;
  continuationReaction: {
    enabled: boolean;
  };
  continuationNotice: {
    mode: "off" | "fallbackOnly" | "always";
    text: string;
  };
  validator: {
    llm: KeepGoingLlmValidatorConfig;
  };
};

export type ContinuationCandidate = {
  runId: string;
  agentId?: string;
  sessionId: string;
  sessionKey: string;
  workspaceDir: string;
  modelProviderId?: string;
  modelId?: string;
  trigger?: string;
  channelId?: string;
  messageProvider?: string;
  success: boolean;
  error?: string;
  durationMs?: number;
  messages: unknown[];
};

export type ContinuationDecision = {
  continue: boolean;
  reason: string;
  followUpInstruction?: string;
};

export type ContinuationValidationContext = {
  runTranscriptMessages?: TranscriptMessage[];
  sessionTranscriptMessages?: TranscriptMessage[];
};

export type SessionRoute = {
  lookupStatus: "ok" | "missing-entry" | "error";
  isSlack: boolean;
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string;
  currentChannelId?: string;
  replyToMode?: SlackReplyToMode;
  spawnedBy?: string;
  sessionFile?: string;
  modelProviderId?: string;
  modelId?: string;
  authProfileId?: string;
  error?: string;
};

export type ContinuationWakeContext = {
  currentMessageId?: string;
  currentChannelId?: string;
  currentThreadTs?: string;
  replyToMode?: SlackReplyToMode;
};

export type LaunchContinuationParams = {
  candidate: ContinuationCandidate;
  decision: ContinuationDecision;
  sessionRoute: SessionRoute;
  wakeContext: ContinuationWakeContext;
  sessionFile: string;
  timeoutMs: number;
};
