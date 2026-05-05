import type { OpenAiLlmCallConfig } from "./types.js";

const DEFAULT_OPENAI_API_KEY_ENV = "OPENAI_API_KEY";

type RuntimeConfigLike = {
  env?: Record<string, unknown>;
  models?: {
    providers?: Record<string, { apiKey?: unknown } | undefined>;
  };
};

function readProcessEnvValue(name: string | undefined): string | undefined {
  const envKeyName = name?.trim();
  if (!envKeyName) {
    return undefined;
  }

  const envValue = process.env[envKeyName];
  return typeof envValue === "string" && envValue.trim() ? envValue.trim() : undefined;
}

function readConfigEnvValue(config: RuntimeConfigLike | undefined, name: string | undefined): string | undefined {
  const envKeyName = name?.trim();
  if (!envKeyName) {
    return undefined;
  }

  const env = config?.env;
  if (!env) {
    return undefined;
  }

  const vars = env.vars;
  const value =
    vars && typeof vars === "object" && !Array.isArray(vars)
      ? (vars as Record<string, unknown>)[envKeyName]
      : undefined;
  const directValue = value ?? env[envKeyName];
  return typeof directValue === "string" && directValue.trim()
    ? directValue.trim()
    : undefined;
}

function readResolvedProviderApiKey(
  config: RuntimeConfigLike | undefined,
): string | undefined {
  const apiKey = config?.models?.providers?.openai?.apiKey;
  if (typeof apiKey !== "string") {
    return undefined;
  }

  const normalized = apiKey.trim();
  if (!normalized || /^\$\{[^}]+\}$/.test(normalized)) {
    return undefined;
  }
  if (/^[A-Z][A-Z0-9_]+$/.test(normalized)) {
    return readConfigEnvValue(config, normalized) ?? readProcessEnvValue(normalized);
  }
  return normalized;
}

export function resolveLlmApiKey(
  config: Pick<OpenAiLlmCallConfig, "apiKey" | "apiKeyEnv">,
  runtimeConfig?: RuntimeConfigLike,
): string | undefined {
  const inlineApiKey = config.apiKey?.trim();
  if (inlineApiKey) {
    return inlineApiKey;
  }

  return (
    readConfigEnvValue(runtimeConfig, config.apiKeyEnv) ??
    readProcessEnvValue(config.apiKeyEnv) ??
    readConfigEnvValue(runtimeConfig, DEFAULT_OPENAI_API_KEY_ENV) ??
    readResolvedProviderApiKey(runtimeConfig) ??
    readProcessEnvValue(DEFAULT_OPENAI_API_KEY_ENV)
  );
}
