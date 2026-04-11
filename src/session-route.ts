import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeString, normalizeThreadId } from "./normalize.js";
import type { SessionRoute } from "./types.js";

type SessionEntry = {
  sessionFile?: string;
  spawnedBy?: string;
  modelProvider?: string;
  model?: string;
  providerOverride?: string;
  modelOverride?: string;
  authProfileOverride?: string;
  authProfileOverrideSource?: "auto" | "user";
  deliveryContext?: {
    channel?: string;
    to?: string;
    accountId?: string;
    threadId?: string | number;
  };
  lastChannel?: string;
  lastTo?: string;
  lastAccountId?: string;
  lastThreadId?: string | number;
  origin?: {
    threadId?: string | number;
  };
};

export function resolveBaseSessionKey(sessionKey: string): string {
  const marker = ":thread:";
  const markerIndex = sessionKey.lastIndexOf(marker);
  if (markerIndex < 0) {
    return sessionKey;
  }
  return sessionKey.slice(0, markerIndex);
}

export function normalizeTrackingSessionKey(sessionKey: string): string {
  return resolveBaseSessionKey(sessionKey.trim());
}

export function isSubagentSessionKey(sessionKey: string): boolean {
  return sessionKey.includes(":subagent:");
}

export function resolveSessionRoute(
  api: OpenClawPluginApi,
  params: { agentId?: string; sessionKey: string },
): SessionRoute {
  try {
    const storePath = api.runtime.agent.session.resolveStorePath(api.config.session?.store, {
      agentId: params.agentId,
    });
    const store = api.runtime.agent.session.loadSessionStore(storePath) as Record<string, SessionEntry>;
    const baseSessionKey = resolveBaseSessionKey(params.sessionKey);
    const entry = store[params.sessionKey] ?? (baseSessionKey !== params.sessionKey ? store[baseSessionKey] : undefined);
    if (!entry) {
      return { lookupStatus: "missing-entry", isSlack: false };
    }

    const channel =
      normalizeString(entry.deliveryContext?.channel) ?? normalizeString(entry.lastChannel);
    const to = normalizeString(entry.deliveryContext?.to) ?? normalizeString(entry.lastTo);
    const accountId =
      normalizeString(entry.deliveryContext?.accountId) ?? normalizeString(entry.lastAccountId);
    const threadId =
      normalizeThreadId(entry.deliveryContext?.threadId) ??
      normalizeThreadId(entry.lastThreadId) ??
      normalizeThreadId(entry.origin?.threadId);
    const modelProviderId =
      normalizeString(entry.modelProvider) ?? normalizeString(entry.providerOverride);
    const modelId = normalizeString(entry.model) ?? normalizeString(entry.modelOverride);
    const authProfileId = normalizeString(entry.authProfileOverride);
    const authProfileIdSource =
      authProfileId && entry.authProfileOverrideSource
        ? entry.authProfileOverrideSource
        : undefined;

    return {
      lookupStatus: "ok",
      isSlack: channel === "slack",
      channel,
      to,
      accountId,
      threadId,
      spawnedBy: normalizeString(entry.spawnedBy),
      sessionFile: normalizeString(entry.sessionFile),
      modelProviderId,
      modelId,
      authProfileId,
      authProfileIdSource,
    };
  } catch (error) {
    return {
      lookupStatus: "error",
      isSlack: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
