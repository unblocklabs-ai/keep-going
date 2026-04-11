export type KeepGoingPluginConfig = {
  enabled: boolean;
  channels: string[];
  timeoutMs?: number;
  heuristic: {
    enabled: boolean;
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

export type SessionRoute = {
  lookupStatus: "ok" | "missing-entry" | "error";
  isSlack: boolean;
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string;
  spawnedBy?: string;
  sessionFile?: string;
  error?: string;
};

export type LaunchContinuationParams = {
  candidate: ContinuationCandidate;
  decision: ContinuationDecision;
  sessionRoute: SessionRoute;
  timeoutMs: number;
};
