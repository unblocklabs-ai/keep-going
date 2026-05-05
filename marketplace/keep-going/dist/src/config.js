import { createDefaultOpenAiValidatorConfig, } from "./openai-validator-config.js";
export const CONTINUATION_REACTION_EMOJI = "eyes";
const DEFAULT_CONFIG = {
    enabled: true,
    debug_logs: false,
    channels: ["slack"],
    continuationReaction: {
        enabled: true,
    },
    validator: {
        llm: createDefaultOpenAiValidatorConfig(),
    },
};
function normalizeStringArray(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    return value
        .filter((entry) => typeof entry === "string")
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean);
}
function normalizePositiveInteger(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return undefined;
    }
    const normalized = Math.floor(value);
    if (normalized < 1) {
        return undefined;
    }
    return normalized;
}
function normalizeBoolean(value, fallback) {
    return typeof value === "boolean" ? value : fallback;
}
export function resolveKeepGoingConfig(raw) {
    const config = raw && typeof raw === "object" ? raw : {};
    const validator = config.validator && typeof config.validator === "object"
        ? config.validator
        : {};
    const validatorLlm = validator.llm && typeof validator.llm === "object"
        ? validator.llm
        : {};
    const continuationReaction = config.continuationReaction && typeof config.continuationReaction === "object"
        ? config.continuationReaction
        : {};
    const legacyUserFacingNotice = config.userFacingNotice && typeof config.userFacingNotice === "object"
        ? config.userFacingNotice
        : {};
    const channels = normalizeStringArray(config.channels);
    const reactionEnabledFallback = normalizeBoolean(legacyUserFacingNotice.enabled, DEFAULT_CONFIG.continuationReaction.enabled);
    return {
        enabled: config.enabled !== false,
        debug_logs: normalizeBoolean(config.debug_logs, DEFAULT_CONFIG.debug_logs),
        channels: channels.length > 0 ? channels : DEFAULT_CONFIG.channels,
        timeoutMs: normalizePositiveInteger(config.timeoutMs),
        continuationReaction: {
            enabled: normalizeBoolean(continuationReaction.enabled, reactionEnabledFallback),
        },
        validator: {
            llm: createDefaultOpenAiValidatorConfig({
                model: typeof validatorLlm.model === "string" && validatorLlm.model.trim()
                    ? validatorLlm.model.trim()
                    : DEFAULT_CONFIG.validator.llm.model,
                systemPrompt: typeof validatorLlm.systemPrompt === "string" && validatorLlm.systemPrompt.trim()
                    ? validatorLlm.systemPrompt
                    : DEFAULT_CONFIG.validator.llm.systemPrompt,
                apiKey: typeof validatorLlm.apiKey === "string" && validatorLlm.apiKey.trim()
                    ? validatorLlm.apiKey.trim()
                    : undefined,
                apiKeyEnv: typeof validatorLlm.apiKeyEnv === "string" && validatorLlm.apiKeyEnv.trim()
                    ? validatorLlm.apiKeyEnv.trim()
                    : DEFAULT_CONFIG.validator.llm.apiKeyEnv,
                maxMessages: normalizePositiveInteger(validatorLlm.maxMessages) ??
                    DEFAULT_CONFIG.validator.llm.maxMessages,
                maxChars: normalizePositiveInteger(validatorLlm.maxChars) ??
                    DEFAULT_CONFIG.validator.llm.maxChars,
                includeCurrentTurnOnly: normalizeBoolean(validatorLlm.includeCurrentTurnOnly, DEFAULT_CONFIG.validator.llm.includeCurrentTurnOnly),
                recentUserMessages: normalizePositiveInteger(validatorLlm.recentUserMessages) ??
                    DEFAULT_CONFIG.validator.llm.recentUserMessages,
                temperature: typeof validatorLlm.temperature === "number" && Number.isFinite(validatorLlm.temperature)
                    ? validatorLlm.temperature
                    : DEFAULT_CONFIG.validator.llm.temperature,
                timeoutMs: normalizePositiveInteger(validatorLlm.timeoutMs) ??
                    DEFAULT_CONFIG.validator.llm.timeoutMs,
            }),
        },
    };
}
