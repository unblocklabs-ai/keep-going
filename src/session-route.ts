import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeString, normalizeThreadId } from "./normalize.js";
import { resolveBaseSessionKey } from "./session-key.js";
import type { SessionRoute, SlackReplyToMode } from "./types.js";

type SessionRouteEntry = {
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
    channels?: OpenClawPluginApi["config"]["channels"];
  };
  runtime: {
    agent: {
      session: {
        resolveStorePath: OpenClawPluginApi["runtime"]["agent"]["session"]["resolveStorePath"];
        getSessionEntryAsync: (params: {
          agentId?: string;
          storePath: string;
          sessionKey: string;
          readConsistency: "latest";
        }) => Promise<SessionRouteEntry | undefined>;
      };
    };
  };
};

function deriveSlackChannelId(to?: string): string | undefined {
  const normalizedTo = normalizeString(to);
  if (!normalizedTo) {
    return undefined;
  }

  const match = /^(?:channel|conversation):(.+)$/.exec(normalizedTo);
  return match?.[1] ? normalizeString(match[1]) : undefined;
}

function resolveSlackReplyToMode(
  config: SessionRouteApi["config"],
  to?: string,
): SlackReplyToMode | undefined {
  const slackConfig = config.channels?.slack;
  if (!slackConfig) {
    return undefined;
  }

  const isDirectMessage = normalizeString(to)?.startsWith("user:") ?? false;
  if (isDirectMessage) {
    return (
      slackConfig.replyToModeByChatType?.direct ??
      slackConfig.replyToMode
    );
  }

  return slackConfig.replyToModeByChatType?.channel ?? slackConfig.replyToMode;
}

function buildSessionRouteFields(
  config: SessionRouteApi["config"],
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
    currentChannelId: channel === "slack" ? deriveSlackChannelId(to) : undefined,
    replyToMode: channel === "slack" ? resolveSlackReplyToMode(config, to) : undefined,
    spawnedBy: normalizeString(entry.spawnedBy),
    modelProviderId: normalizeString(entry.modelProvider),
    modelId: normalizeString(entry.model),
    authProfileId: normalizeString(entry.authProfileOverride),
  };
}

export function isSubagentSessionKey(sessionKey: string): boolean {
  return sessionKey.includes(":subagent:");
}

export async function resolveSessionRoute(
  api: SessionRouteApi,
  params: { agentId?: string; sessionKey: string },
): Promise<SessionRoute> {
  try {
    const storePath = api.runtime.agent.session.resolveStorePath(api.config.session?.store, {
      agentId: params.agentId,
    });
    const readEntry = (sessionKey: string) => api.runtime.agent.session.getSessionEntryAsync({
      agentId: params.agentId,
      storePath,
      sessionKey,
      readConsistency: "latest",
    });
    const baseSessionKey = resolveBaseSessionKey(params.sessionKey);
    const entry =
      (await readEntry(params.sessionKey)) ??
      (baseSessionKey !== params.sessionKey ? await readEntry(baseSessionKey) : undefined);
    if (!entry) {
      return { lookupStatus: "missing-entry", isSlack: false };
    }

    return {
      lookupStatus: "ok",
      storePath,
      ...buildSessionRouteFields(api.config, entry),
    };
  } catch (error) {
    return {
      lookupStatus: "error",
      isSlack: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
