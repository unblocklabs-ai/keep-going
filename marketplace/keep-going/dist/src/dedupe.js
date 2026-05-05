import { ONE_SHOT_DEDUPE_MAX_AGE_MS } from "./constants.js";
export class OneShotDedupe {
    maxAgeMs;
    constructor(maxAgeMs = ONE_SHOT_DEDUPE_MAX_AGE_MS) {
        this.maxAgeMs = maxAgeMs;
    }
    records = new Map();
    prune(now, threadId) {
        for (const [key, record] of this.records.entries()) {
            const isExpired = now - record.createdAt > this.maxAgeMs;
            const matchesThread = Boolean(threadId && record.threadId && record.threadId === threadId);
            if (isExpired || matchesThread) {
                this.records.delete(key);
            }
        }
    }
    makeKey(params) {
        return `${params.sessionKey}::${params.runId}`;
    }
    has(key) {
        return this.records.has(key);
    }
    record(key, value) {
        const createdAt = value.createdAt || Date.now();
        this.prune(createdAt, value.threadId);
        this.records.set(key, {
            ...value,
            createdAt,
        });
    }
    setLaunchedFollowUpRunId(key, followUpRunId) {
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
