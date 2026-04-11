import type { KeepGoingPluginConfig } from "./types.js";

const DEFAULT_CONFIG: KeepGoingPluginConfig = {
  enabled: true,
  channels: ["slack"],
  validator: {
    mode: "heuristic",
    heuristic: {
      enabled: true,
    },
    llm: {
      provider: "openai",
      model: "gpt-5.4-mini",
      apiKeyEnv: "KEEP_GOING_OPENAI_API_KEY",
      maxMessages: 10,
      maxChars: 20_000,
      includeCurrentTurnOnly: true,
      temperature: 0,
      timeoutMs: 15_000,
    },
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

function normalizeValidatorMode(value: unknown): KeepGoingPluginConfig["validator"]["mode"] {
  return value === "llm" ? "llm" : "heuristic";
}

export function resolveKeepGoingConfig(raw: unknown): KeepGoingPluginConfig {
  const config = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const validator =
    config.validator && typeof config.validator === "object"
      ? (config.validator as Record<string, unknown>)
      : {};
  const validatorHeuristic =
    validator.heuristic && typeof validator.heuristic === "object"
      ? (validator.heuristic as Record<string, unknown>)
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
      mode: normalizeValidatorMode(validator.mode),
      heuristic: {
        enabled: normalizeBoolean(
          validatorHeuristic.enabled,
          DEFAULT_CONFIG.validator.heuristic.enabled,
        ),
      },
      llm: {
        provider: "openai",
        model:
          typeof validatorLlm.model === "string" && validatorLlm.model.trim()
            ? validatorLlm.model.trim()
            : DEFAULT_CONFIG.validator.llm.model,
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
        temperature:
          typeof validatorLlm.temperature === "number" && Number.isFinite(validatorLlm.temperature)
            ? validatorLlm.temperature
            : DEFAULT_CONFIG.validator.llm.temperature,
        timeoutMs:
          normalizePositiveInteger(validatorLlm.timeoutMs) ??
          DEFAULT_CONFIG.validator.llm.timeoutMs,
      },
    },
  };
}
