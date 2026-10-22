import { normalizeString, normalizeThreadId } from "./normalize.js";
import { resolveBaseSessionKey } from "./session-key.js";
function deriveSlackChannelId(to) {
    const normalizedTo = normalizeString(to);
    if (!normalizedTo) {
        return undefined;
    }
    const match = /^(?:channel|conversation):(.+)$/.exec(normalizedTo);
    return match?.[1] ? normalizeString(match[1]) : undefined;
}
function resolveSlackReplyToMode(config, to) {
    const slackConfig = config.channels?.slack;
    if (!slackConfig) {
        return undefined;
    }
    const isDirectMessage = normalizeString(to)?.startsWith("user:") ?? false;
    if (isDirectMessage) {
        return (slackConfig.replyToModeByChatType?.direct ??
            slackConfig.replyToMode);
    }
    return slackConfig.replyToModeByChatType?.channel ?? slackConfig.replyToMode;
}
function buildSessionRouteFields(config, entry) {
    const channel = normalizeString(entry.deliveryContext?.channel) ?? normalizeString(entry.lastChannel);
    const to = normalizeString(entry.deliveryContext?.to) ?? normalizeString(entry.lastTo);
    const accountId = normalizeString(entry.deliveryContext?.accountId) ?? normalizeString(entry.lastAccountId);
    const threadId = normalizeThreadId(entry.deliveryContext?.threadId) ??
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
export function isSubagentSessionKey(sessionKey) {
    return sessionKey.includes(":subagent:");
}
export async function resolveSessionRoute(api, params) {
    try {
        const storePath = api.runtime.agent.session.resolveStorePath(api.config.session?.store, {
            agentId: params.agentId,
        });
        const readEntry = (sessionKey) => api.runtime.agent.session.getSessionEntryAsync({
            agentId: params.agentId,
            storePath,
            sessionKey,
            readConsistency: "latest",
        });
        const baseSessionKey = resolveBaseSessionKey(params.sessionKey);
        const entry = (await readEntry(params.sessionKey)) ??
            (baseSessionKey !== params.sessionKey ? await readEntry(baseSessionKey) : undefined);
        if (!entry) {
            return { lookupStatus: "missing-entry", isSlack: false };
        }
        return {
            lookupStatus: "ok",
            storePath,
            ...buildSessionRouteFields(api.config, entry),
        };
    }
    catch (error) {
        return {
            lookupStatus: "error",
            isSlack: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}
