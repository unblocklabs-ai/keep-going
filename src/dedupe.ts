import { ONE_SHOT_DEDUPE_MAX_AGE_MS } from "./constants.js";

type DedupeRecord = {
  createdAt: number;
  reason: string;
  launchedFollowUpRunId?: string;
  threadId?: string;
};

export class OneShotDedupe {
  constructor(private readonly maxAgeMs = ONE_SHOT_DEDUPE_MAX_AGE_MS) {}

  private readonly records = new Map<string, DedupeRecord>();

  private prune(now: number, threadId?: string): void {
    for (const [key, record] of this.records.entries()) {
      const isExpired = now - record.createdAt > this.maxAgeMs;
      const matchesThread = Boolean(threadId && record.threadId && record.threadId === threadId);
      if (isExpired || matchesThread) {
        this.records.delete(key);
      }
    }
  }

  makeKey(params: { sessionKey: string; runId: string }): string {
    return `${params.sessionKey}::${params.runId}`;
  }

  has(key: string): boolean {
    return this.records.has(key);
  }

  record(key: string, value: DedupeRecord): void {
    const createdAt = value.createdAt || Date.now();
    this.prune(createdAt, value.threadId);
    this.records.set(key, {
      ...value,
      createdAt,
    });
  }

  setLaunchedFollowUpRunId(key: string, followUpRunId: string | undefined): void {
    if (!followUpRunId) {
      return;
    }
    const existing = this.records.get(key);
    if (!existing) {
      return;
    }
    this.records.set(key, {
      ...existing,
      launchedFollowUpRunId: followUpRunId,
    });
  }
}
