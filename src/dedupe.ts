import { ONE_SHOT_DEDUPE_MAX_AGE_MS } from "./constants.js";

type DedupeRecord = {
  createdAt: number;
  reason: string;
  threadId?: string;
};

export class OneShotDedupe {
  constructor(
    private readonly maxAgeMs = ONE_SHOT_DEDUPE_MAX_AGE_MS,
    private readonly now = () => Date.now(),
  ) {}

  private readonly records = new Map<string, DedupeRecord>();

  private prune(now: number): void {
    for (const [key, record] of this.records.entries()) {
      const isExpired = now - record.createdAt > this.maxAgeMs;
      if (isExpired) {
        this.records.delete(key);
      }
    }
  }

  makeKey(params: { sessionKey: string; runId: string }): string {
    return `${params.sessionKey}::${params.runId}`;
  }

  has(key: string): boolean {
    this.prune(this.now());
    return this.records.has(key);
  }

  record(key: string, value: DedupeRecord): void {
    const createdAt = value.createdAt ?? this.now();
    this.prune(createdAt);
    this.records.set(key, {
      ...value,
      createdAt,
    });
  }
}
