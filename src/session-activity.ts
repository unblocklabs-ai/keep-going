import { normalizeTranscriptMessages, type TranscriptMessage } from "./messages.js";
import { normalizeString } from "./normalize.js";
import { normalizeTrackingSessionKey } from "./session-route.js";

type ActivitySnapshot = {
  messageId?: string;
};

type GuardSnapshot = {
  sessionKey?: ActivitySnapshot;
  sessionFile?: ActivitySnapshot;
};

type TranscriptUpdate = {
  sessionFile: string;
  sessionKey?: string;
  message?: unknown;
  messageId?: string;
};

const STALE_RUN_STATE_MAX_AGE_MS = 5 * 60 * 1000;

export class SessionActivityTracker {
  private readonly activeRunIdsBySessionKey = new Map<string, Set<string>>();
  private readonly sessionKeyByRunId = new Map<string, string>();
  private readonly transcriptMessagesByRunId = new Map<string, TranscriptMessage[]>();
  private readonly transcriptBySessionKey = new Map<string, ActivitySnapshot>();
  private readonly transcriptBySessionFile = new Map<string, ActivitySnapshot>();
  private readonly endedRunAtByRunId = new Map<string, number>();

  markRunStarted(params: { sessionKey?: string; runId?: string }): void {
    this.pruneStaleRunState(Date.now());
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
    if (!this.transcriptMessagesByRunId.has(runId)) {
      this.transcriptMessagesByRunId.set(runId, []);
    }
  }

  markRunEnded(params: { sessionKey?: string; runId?: string }): void {
    this.pruneStaleRunState(Date.now());
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
    if (active.size === 0) {
      this.activeRunIdsBySessionKey.delete(sessionKey);
    }
    this.endedRunAtByRunId.set(runId, Date.now());
  }

  hasActiveRun(sessionKey?: string): boolean {
    this.pruneStaleRunState(Date.now());
    const key = normalizeSessionKey(sessionKey);
    if (!key) {
      return false;
    }
    const active = this.activeRunIdsBySessionKey.get(key);
    return Boolean(active && active.size > 0);
  }

  recordTranscriptUpdate(update: TranscriptUpdate): void {
    this.pruneStaleRunState(Date.now());
    const sessionKey = normalizeSessionKey(update.sessionKey);
    if (sessionKey && update.message !== undefined) {
      const activeRunIds = this.activeRunIdsBySessionKey.get(sessionKey);
      if (activeRunIds && activeRunIds.size > 0) {
        const normalizedMessages = normalizeTranscriptMessages([update.message]);
        if (normalizedMessages.length > 0) {
          for (const runId of activeRunIds) {
            const existing = this.transcriptMessagesByRunId.get(runId) ?? [];
            existing.push(...normalizedMessages);
            this.transcriptMessagesByRunId.set(runId, existing);
          }
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

  clearRun(runId?: string): void {
    const key = normalizeString(runId);
    if (!key) {
      return;
    }
    this.sessionKeyByRunId.delete(key);
    this.transcriptMessagesByRunId.delete(key);
    this.endedRunAtByRunId.delete(key);
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
      this.sessionKeyByRunId.delete(runId);
      this.transcriptMessagesByRunId.delete(runId);
      this.endedRunAtByRunId.delete(runId);
    }
  }
}

function isConversationMessage(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const role = (message as { role?: unknown }).role;
  return role === "user" || role === "assistant";
}

function normalizeSessionKey(value: unknown): string | undefined {
  const sessionKey = normalizeString(value);
  return sessionKey ? normalizeTrackingSessionKey(sessionKey) : undefined;
}
