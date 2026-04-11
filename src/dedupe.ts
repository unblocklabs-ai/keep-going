type DedupeRecord = {
  createdAt: number;
  reason: string;
  launchedFollowUpRunId?: string;
};

export class OneShotDedupe {
  private readonly records = new Map<string, DedupeRecord>();

  makeKey(params: { sessionKey: string; runId: string }): string {
    return `${params.sessionKey}::${params.runId}`;
  }

  has(key: string): boolean {
    return this.records.has(key);
  }

  record(key: string, value: DedupeRecord): void {
    this.records.set(key, value);
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
