import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input-runtime";
const DEFAULT_ACCOUNT_ID = "default";
const DEFAULT_SLACK_REACTION_TIMEOUT_MS = 3000;
export async function addSlackReaction(api, params, options = {}) {
    const token = resolveSlackBotToken(api, params.accountId);
    const fetchImpl = options.fetchImpl ?? fetch;
    const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetchImpl("https://slack.com/api/reactions.add", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({
                channel: params.channelId,
                timestamp: params.messageId,
                name: normalizeEmoji(params.emoji),
            }),
            signal: controller.signal,
        });
        if (!response.ok) {
            throw new Error(`Slack reaction request failed with HTTP ${response.status}`);
        }
        const result = await response.json();
        if (result.ok === true || result.error === "already_reacted") {
            return;
        }
        throw new Error(`Slack reaction request failed: ${formatSlackError(result.error)}`);
    }
    catch (error) {
        if (controller.signal.aborted) {
            throw new Error(`Slack reaction request timed out after ${timeoutMs}ms`);
        }
        throw error;
    }
    finally {
        clearTimeout(timeout);
    }
}
function resolveSlackBotToken(api, accountId) {
    const slack = asRecord(asRecord(api.config.channels)?.slack);
    const normalizedAccountId = normalizeAccountId(accountId ?? asString(slack.defaultAccount) ?? DEFAULT_ACCOUNT_ID);
    const account = asRecord(asRecord(slack.accounts)?.[normalizedAccountId]);
    const accountToken = normalizeConfiguredToken(account.botToken, `channels.slack.accounts.${normalizedAccountId}.botToken`);
    const rootToken = normalizeConfiguredToken(slack.botToken, "channels.slack.botToken");
    const envToken = normalizedAccountId === DEFAULT_ACCOUNT_ID
        ? normalizeConfiguredToken(process.env.SLACK_BOT_TOKEN, "SLACK_BOT_TOKEN")
        : undefined;
    const token = accountToken ?? rootToken ?? envToken;
    if (!token) {
        throw new Error("SLACK_BOT_TOKEN or channels.slack.botToken is required for Slack reactions");
    }
    return token;
}
function normalizeConfiguredToken(value, path) {
    return normalizeResolvedSecretInputString({
        value,
        path,
    });
}
function normalizeEmoji(raw) {
    const normalized = raw.trim().replace(/^:+|:+$/g, "");
    if (!normalized) {
        throw new Error("Emoji is required for Slack reactions");
    }
    return normalized;
}
function normalizeTimeoutMs(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return DEFAULT_SLACK_REACTION_TIMEOUT_MS;
    }
    const normalized = Math.floor(value);
    return normalized > 0 ? normalized : DEFAULT_SLACK_REACTION_TIMEOUT_MS;
}
function normalizeAccountId(value) {
    const normalized = value.trim();
    return normalized || DEFAULT_ACCOUNT_ID;
}
function asRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : {};
}
function asString(value) {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function formatSlackError(error) {
    return typeof error === "string" && error.trim() ? error : "unknown_error";
}
