export type KeepGoingValidatorMode = "heuristic" | "llm";

export type KeepGoingHeuristicValidatorConfig = {
  enabled: boolean;
};

export type KeepGoingLlmValidatorConfig = {
  provider: "openai";
  model: string;
  apiKey?: string;
  apiKeyEnv?: string;
  maxMessages: number;
  maxChars: number;
  includeCurrentTurnOnly: boolean;
  temperature?: number;
  timeoutMs?: number;
};

export type KeepGoingPluginConfig = {
  enabled: boolean;
  channels: string[];
  timeoutMs?: number;
  validator: {
    mode: KeepGoingValidatorMode;
    heuristic: KeepGoingHeuristicValidatorConfig;
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
  runTranscriptMessages?: import("./messages.js").TranscriptMessage[];
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
  authProfileIdSource?: "auto" | "user";
  error?: string;
};

export type LaunchContinuationParams = {
  candidate: ContinuationCandidate;
  decision: ContinuationDecision;
  sessionRoute: SessionRoute;
  sessionFile: string;
  timeoutMs: number;
};
