import { normalizeString } from "./normalize.js";
import { normalizeOptionalTrackingSessionKey } from "./session-key.js";

type ActiveChildRecord = {
  childSessionKey: string;
  createdAt: number;
};

const STALE_ACTIVE_SUBAGENT_MAX_AGE_MS = 30 * 60 * 1000;

export class ActiveSubagentTracker {
  private readonly activeByRequesterSessionKey = new Map<string, Map<string, ActiveChildRecord>>();

  markSpawned(params: {
    requesterSessionKey?: string;
    childSessionKey?: string;
  }): void {
    this.pruneStaleChildren(Date.now());
    const requesterSessionKey = normalizeRequesterKey(params.requesterSessionKey);
    const childSessionKey = normalizeString(params.childSessionKey);
    if (!requesterSessionKey || !childSessionKey) {
      return;
    }

    let children = this.activeByRequesterSessionKey.get(requesterSessionKey);
    if (!children) {
      children = new Map<string, ActiveChildRecord>();
      this.activeByRequesterSessionKey.set(requesterSessionKey, children);
    }

    children.set(childSessionKey, {
      childSessionKey,
      createdAt: Date.now(),
    });
  }

  markEnded(params: {
    requesterSessionKey?: string;
    childSessionKey?: string;
  }): void {
    this.pruneStaleChildren(Date.now());
    const requesterSessionKey = normalizeRequesterKey(params.requesterSessionKey);
    const childSessionKey = normalizeString(params.childSessionKey);
    if (!requesterSessionKey || !childSessionKey) {
      return;
    }

    this.deleteChild(requesterSessionKey, childSessionKey);
  }

  hasActiveChildren(requesterSessionKey?: string): boolean {
    this.pruneStaleChildren(Date.now(), requesterSessionKey);
    const key = normalizeRequesterKey(requesterSessionKey);
    if (!key) {
      return false;
    }
    const children = this.activeByRequesterSessionKey.get(key);
    return Boolean(children && children.size > 0);
  }

  getActiveChildSessionKeys(requesterSessionKey?: string): string[] {
    this.pruneStaleChildren(Date.now(), requesterSessionKey);
    const key = normalizeRequesterKey(requesterSessionKey);
    if (!key) {
      return [];
    }
    const children = this.activeByRequesterSessionKey.get(key);
    return children ? Array.from(children.keys()).sort() : [];
  }

  private deleteChild(requesterSessionKey: string, childSessionKey: string): void {
    const children = this.activeByRequesterSessionKey.get(requesterSessionKey);
    if (!children) {
      return;
    }

    children.delete(childSessionKey);
    if (children.size === 0) {
      this.activeByRequesterSessionKey.delete(requesterSessionKey);
    }
  }

  private pruneStaleChildren(now: number, requesterSessionKey?: string): void {
    const normalizedRequesterKey = normalizeRequesterKey(requesterSessionKey);
    const requesterKeys = normalizedRequesterKey
      ? [normalizedRequesterKey]
      : Array.from(this.activeByRequesterSessionKey.keys());

    for (const key of requesterKeys) {
      const children = this.activeByRequesterSessionKey.get(key);
      if (!children) {
        continue;
      }

      for (const [childKey, record] of children.entries()) {
        if (now - record.createdAt <= STALE_ACTIVE_SUBAGENT_MAX_AGE_MS) {
          continue;
        }
        children.delete(childKey);
      }

      if (children.size === 0) {
        this.activeByRequesterSessionKey.delete(key);
      }
    }
  }
}

function normalizeRequesterKey(value?: string): string | undefined {
  return normalizeOptionalTrackingSessionKey(normalizeString(value));
}
