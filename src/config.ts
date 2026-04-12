import {
  createDefaultOpenAiValidatorConfig,
} from "./openai-validator-config.js";
import type { KeepGoingPluginConfig } from "./types.js";

const DEFAULT_CONFIG: KeepGoingPluginConfig = {
  enabled: true,
  channels: ["slack"],
  validator: {
    llm: createDefaultOpenAiValidatorConfig(),
  },
};

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const normalized = Math.floor(value);
  if (normalized < 1) {
    return undefined;
  }
  return normalized;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function resolveKeepGoingConfig(raw: unknown): KeepGoingPluginConfig {
  const config = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const validator =
    config.validator && typeof config.validator === "object"
      ? (config.validator as Record<string, unknown>)
      : {};
  const validatorLlm =
    validator.llm && typeof validator.llm === "object"
      ? (validator.llm as Record<string, unknown>)
      : {};
  const channels = normalizeStringArray(config.channels);

  return {
    enabled: config.enabled !== false,
    channels: channels.length > 0 ? channels : DEFAULT_CONFIG.channels,
    timeoutMs: normalizePositiveInteger(config.timeoutMs),
    validator: {
      llm: createDefaultOpenAiValidatorConfig({
        model:
          typeof validatorLlm.model === "string" && validatorLlm.model.trim()
            ? validatorLlm.model.trim()
            : DEFAULT_CONFIG.validator.llm.model,
        systemPrompt:
          typeof validatorLlm.systemPrompt === "string" && validatorLlm.systemPrompt.trim()
            ? validatorLlm.systemPrompt
            : DEFAULT_CONFIG.validator.llm.systemPrompt,
        apiKey:
          typeof validatorLlm.apiKey === "string" && validatorLlm.apiKey.trim()
            ? validatorLlm.apiKey.trim()
            : undefined,
        apiKeyEnv:
          typeof validatorLlm.apiKeyEnv === "string" && validatorLlm.apiKeyEnv.trim()
            ? validatorLlm.apiKeyEnv.trim()
            : DEFAULT_CONFIG.validator.llm.apiKeyEnv,
        maxMessages:
          normalizePositiveInteger(validatorLlm.maxMessages) ??
          DEFAULT_CONFIG.validator.llm.maxMessages,
        maxChars:
          normalizePositiveInteger(validatorLlm.maxChars) ??
          DEFAULT_CONFIG.validator.llm.maxChars,
        includeCurrentTurnOnly: normalizeBoolean(
          validatorLlm.includeCurrentTurnOnly,
          DEFAULT_CONFIG.validator.llm.includeCurrentTurnOnly,
        ),
        recentUserMessages:
          normalizePositiveInteger(validatorLlm.recentUserMessages) ??
          DEFAULT_CONFIG.validator.llm.recentUserMessages,
        temperature:
          typeof validatorLlm.temperature === "number" && Number.isFinite(validatorLlm.temperature)
            ? validatorLlm.temperature
            : DEFAULT_CONFIG.validator.llm.temperature,
        timeoutMs:
          normalizePositiveInteger(validatorLlm.timeoutMs) ??
          DEFAULT_CONFIG.validator.llm.timeoutMs,
      }),
    },
  };
}
