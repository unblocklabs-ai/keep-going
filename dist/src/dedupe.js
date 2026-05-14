import { ONE_SHOT_DEDUPE_MAX_AGE_MS } from "./constants.js";
export class OneShotDedupe {
    maxAgeMs;
    now;
    constructor(maxAgeMs = ONE_SHOT_DEDUPE_MAX_AGE_MS, now = () => Date.now()) {
        this.maxAgeMs = maxAgeMs;
        this.now = now;
    }
    records = new Map();
    prune(now) {
        for (const [key, record] of this.records.entries()) {
            const isExpired = now - record.createdAt > this.maxAgeMs;
            if (isExpired) {
                this.records.delete(key);
            }
        }
    }
    makeKey(params) {
        return `${params.sessionKey}::${params.runId}`;
    }
    has(key) {
        this.prune(this.now());
        return this.records.has(key);
    }
    record(key, value) {
        const createdAt = value.createdAt ?? this.now();
        this.prune(createdAt);
        this.records.set(key, {
            ...value,
            createdAt,
        });
    }
}
