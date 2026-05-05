import { createDefaultOpenAiValidatorConfig, } from "./openai-validator-config.js";
import { isSecretRef } from "openclaw/plugin-sdk/secret-input-runtime";
export const CONTINUATION_REACTION_EMOJI = "eyes";
export const DEFAULT_CONTINUATION_NOTICE_TEXT = ":eyes: continuing...";
const DEFAULT_CONFIG = {
    enabled: true,
    debug_logs: false,
    channels: ["slack"],
    continuationReaction: {
        enabled: true,
    },
    continuationNotice: {
        mode: "fallbackOnly",
        text: DEFAULT_CONTINUATION_NOTICE_TEXT,
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
function normalizeNoticeMode(value, fallback) {
    if (value === "off" || value === "fallbackOnly" || value === "always") {
        return value;
    }
    if (value === false) {
        return "off";
    }
    if (value === true) {
        return "always";
    }
    return fallback;
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
    const continuationNotice = config.continuationNotice && typeof config.continuationNotice === "object"
        ? config.continuationNotice
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
        continuationNotice: {
            mode: normalizeNoticeMode(continuationNotice.mode ?? continuationNotice.enabled, DEFAULT_CONFIG.continuationNotice.mode),
            text: typeof continuationNotice.text === "string" && continuationNotice.text.trim()
                ? continuationNotice.text.trim()
                : DEFAULT_CONFIG.continuationNotice.text,
        },
        validator: {
            llm: createDefaultOpenAiValidatorConfig({
                model: typeof validatorLlm.model === "string" && validatorLlm.model.trim()
                    ? validatorLlm.model.trim()
                    : DEFAULT_CONFIG.validator.llm.model,
                systemPrompt: typeof validatorLlm.systemPrompt === "string" && validatorLlm.systemPrompt.trim()
                    ? validatorLlm.systemPrompt
                    : DEFAULT_CONFIG.validator.llm.systemPrompt,
                apiKeyRef: isSecretRef(validatorLlm.apiKeyRef)
                    ? validatorLlm.apiKeyRef
                    : undefined,
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
