import type { TranscriptMessage } from "./transcript-types.js";

export type KeepGoingLlmValidatorProvider = "openai";

export type OpenAiLlmCallConfig = {
  provider: KeepGoingLlmValidatorProvider;
  model: string;
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
  spawnedBy?: string;
  sessionFile?: string;
  modelProviderId?: string;
  modelId?: string;
  authProfileId?: string;
  error?: string;
};

export type LaunchContinuationParams = {
  candidate: ContinuationCandidate;
  decision: ContinuationDecision;
  sessionRoute: SessionRoute;
  sessionFile: string;
  timeoutMs: number;
};
