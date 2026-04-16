import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeString, normalizeThreadId } from "./normalize.js";
import { resolveBaseSessionKey } from "./session-key.js";
import type { SessionRoute } from "./types.js";

type SessionRouteEntry = {
  sessionFile?: string;
  spawnedBy?: string;
  modelProvider?: string;
  model?: string;
  authProfileOverride?: string;
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
};

export type SessionRouteApi = {
  config: {
    session?: OpenClawPluginApi["config"]["session"];
  };
  runtime: {
    agent: {
      session: {
        resolveStorePath: OpenClawPluginApi["runtime"]["agent"]["session"]["resolveStorePath"];
        loadSessionStore: (storePath: string) => Record<string, SessionRouteEntry>;
      };
    };
  };
};

function buildSessionRouteFields(
  entry: SessionRouteEntry,
): Omit<SessionRoute, "lookupStatus"> {
  const channel =
    normalizeString(entry.deliveryContext?.channel) ?? normalizeString(entry.lastChannel);
  const to = normalizeString(entry.deliveryContext?.to) ?? normalizeString(entry.lastTo);
  const accountId =
    normalizeString(entry.deliveryContext?.accountId) ?? normalizeString(entry.lastAccountId);
  const threadId =
    normalizeThreadId(entry.deliveryContext?.threadId) ??
    normalizeThreadId(entry.lastThreadId);

  return {
    isSlack: channel === "slack",
    channel,
    to,
    accountId,
    threadId,
    spawnedBy: normalizeString(entry.spawnedBy),
    sessionFile: normalizeString(entry.sessionFile),
    modelProviderId: normalizeString(entry.modelProvider),
    modelId: normalizeString(entry.model),
    authProfileId: normalizeString(entry.authProfileOverride),
  };
}

export function isSubagentSessionKey(sessionKey: string): boolean {
  return sessionKey.includes(":subagent:");
}

export function resolveSessionRoute(
  api: SessionRouteApi,
  params: { agentId?: string; sessionKey: string },
): SessionRoute {
  try {
    const storePath = api.runtime.agent.session.resolveStorePath(api.config.session?.store, {
      agentId: params.agentId,
    });
    const store = api.runtime.agent.session.loadSessionStore(storePath);
    const baseSessionKey = resolveBaseSessionKey(params.sessionKey);
    const entry =
      store[params.sessionKey] ??
      (baseSessionKey !== params.sessionKey ? store[baseSessionKey] : undefined);
    if (!entry) {
      return { lookupStatus: "missing-entry", isSlack: false };
    }

    return {
      lookupStatus: "ok",
      ...buildSessionRouteFields(entry),
    };
  } catch (error) {
    return {
      lookupStatus: "error",
      isSlack: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
