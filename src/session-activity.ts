import { normalizeTranscriptMessages, type TranscriptNormalizationOptions } from "./messages.js";
import { normalizeString } from "./normalize.js";
import { normalizeOptionalTrackingSessionKey } from "./session-key.js";
import type { TranscriptMessage } from "./transcript-types.js";

type ActivitySnapshot = {
  messageId?: string;
};

type UserMessageSnapshot = {
  messageId: string;
};

type GuardSnapshot = {
  sessionKey?: ActivitySnapshot;
  sessionFile?: ActivitySnapshot;
};

type RunState = {
  runId: string;
  sessionKey: string;
  startSequence: number;
  startedAt: number;
  endedAt?: number;
  active: boolean;
  trigger?: string;
  source?: string;
};

type RunStartBarrier = {
  lastStartSequence: number;
};

type RunQueryResult = {
  runId: string;
  sessionKey: string;
  startSequence: number;
  startedAt: number;
  endedAt?: number;
  active: boolean;
  trigger?: string;
  source?: string;
};

type TranscriptUpdate = {
  sessionFile: string;
  sessionKey?: string;
  message?: unknown;
  messageId?: string;
};

const STALE_RUN_STATE_MAX_AGE_MS = 5 * 60 * 1000;
const MAX_SESSION_TRANSCRIPT_MESSAGES = 200;

export class SessionActivityTracker {
  private readonly activeRunIdsBySessionKey = new Map<string, Set<string>>();
  private readonly sessionKeyByRunId = new Map<string, string>();
  private readonly transcriptMessagesByRunId = new Map<string, TranscriptMessage[]>();
  private readonly transcriptMessagesBySessionKey = new Map<string, TranscriptMessage[]>();
  private readonly transcriptBySessionKey = new Map<string, ActivitySnapshot>();
  private readonly transcriptBySessionFile = new Map<string, ActivitySnapshot>();
  private readonly lastUserMessageBySessionKey = new Map<string, UserMessageSnapshot>();
  private readonly lastUserMessageBySessionFile = new Map<string, UserMessageSnapshot>();
  private readonly endedRunAtByRunId = new Map<string, number>();
  private readonly runStateByRunId = new Map<string, RunState>();
  private readonly latestRunStartSequenceBySessionKey = new Map<string, number>();
  private nextRunStartSequence = 0;
  private readonly transcriptNormalizationOptions: TranscriptNormalizationOptions;

  constructor(options: TranscriptNormalizationOptions = {}) {
    this.transcriptNormalizationOptions = options;
  }

  markRunStarted(params: {
    sessionKey?: string;
    runId?: string;
    trigger?: string;
    source?: string;
  }): void {
    const now = Date.now();
    this.pruneStaleRunState(now);
    const sessionKey = normalizeSessionKey(params.sessionKey);
    const runId = normalizeString(params.runId);
    if (!sessionKey || !runId) {
      return;
    }

    let active = this.activeRunIdsBySessionKey.get(sessionKey);
    if (!active) {
      active = new Set<string>();
      this.activeRunIdsBySessionKey.set(sessionKey, active);
    }
    active.add(runId);
    this.sessionKeyByRunId.set(runId, sessionKey);
    this.endedRunAtByRunId.delete(runId);

    const existingState = this.runStateByRunId.get(runId);
    const canReuseSequence = existingState?.sessionKey === sessionKey;
    const startSequence = canReuseSequence
      ? existingState.startSequence
      : ++this.nextRunStartSequence;
    this.runStateByRunId.set(runId, {
      runId,
      sessionKey,
      startSequence,
      startedAt: canReuseSequence ? existingState.startedAt : now,
      active: true,
      trigger: normalizeString(params.trigger) ?? existingState?.trigger,
      source: normalizeString(params.source) ?? existingState?.source,
    });
    const lastStartSequence = this.latestRunStartSequenceBySessionKey.get(sessionKey) ?? 0;
    if (startSequence > lastStartSequence) {
      this.latestRunStartSequenceBySessionKey.set(sessionKey, startSequence);
    }

    if (!this.transcriptMessagesByRunId.has(runId)) {
      this.transcriptMessagesByRunId.set(runId, []);
    }
  }

  markRunEnded(params: { sessionKey?: string; runId?: string }): void {
    const now = Date.now();
    this.pruneStaleRunState(now);
    const runId = normalizeString(params.runId);
    if (!runId) {
      return;
    }

    const sessionKey =
      normalizeSessionKey(params.sessionKey) ?? this.sessionKeyByRunId.get(runId);
    if (!sessionKey) {
      return;
    }

    const active = this.activeRunIdsBySessionKey.get(sessionKey);
    if (!active) {
      return;
    }
    active.delete(runId);
    this.deleteEmptyActiveRunSet(sessionKey, active);
    this.endedRunAtByRunId.set(runId, now);
    const runState = this.runStateByRunId.get(runId);
    if (runState) {
      this.runStateByRunId.set(runId, {
        ...runState,
        active: false,
        endedAt: now,
      });
    }
    this.cleanupSessionMetadataIfUnused(sessionKey);
  }

  captureRunStartBarrier(params: { sessionKey?: string }): RunStartBarrier {
    this.pruneStaleRunState(Date.now());
    const sessionKey = normalizeSessionKey(params.sessionKey);
    return {
      lastStartSequence: sessionKey
        ? (this.latestRunStartSequenceBySessionKey.get(sessionKey) ?? 0)
        : 0,
    };
  }

  getRunsStartedAfter(params: {
    sessionKey?: string;
    after: RunStartBarrier;
    ignoreRunIds?: string[];
  }): RunQueryResult[] {
    this.pruneStaleRunState(Date.now());
    const sessionKey = normalizeSessionKey(params.sessionKey);
    if (!sessionKey) {
      return [];
    }

    const ignoredRunIds = new Set(
      (params.ignoreRunIds ?? [])
        .map((runId) => normalizeString(runId))
        .filter((runId): runId is string => Boolean(runId)),
    );

    return [...this.runStateByRunId.values()]
      .filter((runState) => {
        if (runState.sessionKey !== sessionKey) {
          return false;
        }
        if (ignoredRunIds.has(runState.runId)) {
          return false;
        }
        return runState.startSequence > params.after.lastStartSequence;
      })
      .sort((left, right) => left.startSequence - right.startSequence)
      .map((runState) => ({
        runId: runState.runId,
        sessionKey: runState.sessionKey,
        startSequence: runState.startSequence,
        startedAt: runState.startedAt,
        endedAt: runState.endedAt,
        active: runState.active,
        trigger: runState.trigger,
        source: runState.source,
      }));
  }

  recordTranscriptUpdate(update: TranscriptUpdate): void {
    this.pruneStaleRunState(Date.now());
    const sessionKey = normalizeSessionKey(update.sessionKey);
    if (sessionKey && update.message !== undefined) {
      const normalizedMessages = normalizeTranscriptMessages(
        [update.message],
        this.transcriptNormalizationOptions,
      );
      if (normalizedMessages.length > 0) {
        this.appendSessionTranscriptMessages(sessionKey, normalizedMessages);
      }

      const activeRunIds = this.activeRunIdsBySessionKey.get(sessionKey);
      if (activeRunIds && activeRunIds.size > 0 && normalizedMessages.length > 0) {
        for (const runId of activeRunIds) {
          const existing = this.transcriptMessagesByRunId.get(runId) ?? [];
          existing.push(...normalizedMessages);
          this.transcriptMessagesByRunId.set(runId, existing);
        }
      }
    }

    if (!isConversationMessage(update.message)) {
      return;
    }

    const sessionFile = normalizeString(update.sessionFile);
    const messageId = normalizeString(update.messageId);
    if (!sessionFile || !messageId) {
      return;
    }

    this.transcriptBySessionFile.set(sessionFile, { messageId });
    if (sessionKey) {
      this.transcriptBySessionKey.set(sessionKey, { messageId });
    }

    if (getMessageRole(update.message) !== "user") {
      return;
    }

    const userSnapshot: UserMessageSnapshot = { messageId };
    this.lastUserMessageBySessionFile.set(sessionFile, userSnapshot);
    if (sessionKey) {
      this.lastUserMessageBySessionKey.set(sessionKey, userSnapshot);
    }
  }

  captureSnapshot(params: { sessionKey?: string; sessionFile?: string }): GuardSnapshot {
    const sessionKey = normalizeSessionKey(params.sessionKey);
    const sessionFile = normalizeString(params.sessionFile);
    return {
      ...(sessionKey ? { sessionKey: this.transcriptBySessionKey.get(sessionKey) } : {}),
      ...(sessionFile ? { sessionFile: this.transcriptBySessionFile.get(sessionFile) } : {}),
    };
  }

  hasTranscriptChanged(
    snapshot: GuardSnapshot,
    params: { sessionKey?: string; sessionFile?: string },
  ): boolean {
    const sessionKey = normalizeSessionKey(params.sessionKey);
    if (sessionKey && this.changed(snapshot.sessionKey, this.transcriptBySessionKey.get(sessionKey))) {
      return true;
    }

    const sessionFile = normalizeString(params.sessionFile);
    if (
      sessionFile &&
      this.changed(snapshot.sessionFile, this.transcriptBySessionFile.get(sessionFile))
    ) {
      return true;
    }

    return false;
  }

  getRunTranscriptMessages(runId?: string): TranscriptMessage[] {
    this.pruneStaleRunState(Date.now());
    const key = normalizeString(runId);
    if (!key) {
      return [];
    }
    return [...(this.transcriptMessagesByRunId.get(key) ?? [])];
  }

  getSessionTranscriptMessages(sessionKey?: string): TranscriptMessage[] {
    this.pruneStaleRunState(Date.now());
    const key = normalizeSessionKey(sessionKey);
    if (!key) {
      return [];
    }
    return [...(this.transcriptMessagesBySessionKey.get(key) ?? [])];
  }

  getLatestUserMessageId(params: { sessionKey?: string; sessionFile?: string }): string | undefined {
    this.pruneStaleRunState(Date.now());
    const sessionKey = normalizeSessionKey(params.sessionKey);
    const bySessionKey = sessionKey
      ? this.lastUserMessageBySessionKey.get(sessionKey)?.messageId
      : undefined;
    if (bySessionKey) {
      return bySessionKey;
    }

    const sessionFile = normalizeString(params.sessionFile);
    return sessionFile ? this.lastUserMessageBySessionFile.get(sessionFile)?.messageId : undefined;
  }

  clearRun(runId?: string): void {
    const key = normalizeString(runId);
    if (!key) {
      return;
    }
    const sessionKey = this.sessionKeyByRunId.get(key) ?? this.runStateByRunId.get(key)?.sessionKey;
    if (sessionKey) {
      const active = this.activeRunIdsBySessionKey.get(sessionKey);
      if (active) {
        active.delete(key);
        this.deleteEmptyActiveRunSet(sessionKey, active);
      }
    }
    this.sessionKeyByRunId.delete(key);
    this.transcriptMessagesByRunId.delete(key);
    this.endedRunAtByRunId.delete(key);
    this.runStateByRunId.delete(key);
    this.cleanupSessionMetadataIfUnused(sessionKey);
  }

  private changed(previous?: ActivitySnapshot, current?: ActivitySnapshot): boolean {
    if (!previous && !current) {
      return false;
    }
    if (!previous || !current) {
      return true;
    }
    return previous.messageId !== current.messageId;
  }

  private pruneStaleRunState(now: number): void {
    for (const [runId, endedAt] of this.endedRunAtByRunId.entries()) {
      if (now - endedAt <= STALE_RUN_STATE_MAX_AGE_MS) {
        continue;
      }
      const sessionKey =
        this.sessionKeyByRunId.get(runId) ?? this.runStateByRunId.get(runId)?.sessionKey;
      this.sessionKeyByRunId.delete(runId);
      this.transcriptMessagesByRunId.delete(runId);
      this.endedRunAtByRunId.delete(runId);
      this.runStateByRunId.delete(runId);
      this.cleanupSessionMetadataIfUnused(sessionKey);
    }
  }

  private appendSessionTranscriptMessages(
    sessionKey: string,
    normalizedMessages: TranscriptMessage[],
  ): void {
    const existing = this.transcriptMessagesBySessionKey.get(sessionKey) ?? [];
    existing.push(...normalizedMessages);
    const trimmed =
      existing.length > MAX_SESSION_TRANSCRIPT_MESSAGES
        ? existing.slice(-MAX_SESSION_TRANSCRIPT_MESSAGES)
        : existing;
    this.transcriptMessagesBySessionKey.set(sessionKey, trimmed);
  }

  private deleteEmptyActiveRunSet(sessionKey: string, active: Set<string>): void {
    if (active.size === 0) {
      this.activeRunIdsBySessionKey.delete(sessionKey);
    }
  }

  private cleanupSessionMetadataIfUnused(sessionKey?: string): void {
    if (!sessionKey) {
      return;
    }
    if (this.activeRunIdsBySessionKey.has(sessionKey)) {
      return;
    }
    for (const runState of this.runStateByRunId.values()) {
      if (runState.sessionKey === sessionKey) {
        return;
      }
    }
    this.latestRunStartSequenceBySessionKey.delete(sessionKey);
  }
}

function isConversationMessage(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const role = (message as { role?: unknown }).role;
  return role === "user" || role === "assistant";
}

function getMessageRole(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }

  const role = (message as { role?: unknown }).role;
  return typeof role === "string" ? role : undefined;
}

function normalizeSessionKey(value?: string): string | undefined {
  return normalizeOptionalTrackingSessionKey(normalizeString(value));
}
