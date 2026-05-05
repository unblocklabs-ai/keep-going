import type { OpenAiLlmCallConfig } from "./types.js";

const DEFAULT_OPENAI_API_KEY_ENV = "OPENAI_API_KEY";

function readEnvValue(name: string | undefined): string | undefined {
  const envKeyName = name?.trim();
  if (!envKeyName) {
    return undefined;
  }

  const envValue = process.env[envKeyName];
  return typeof envValue === "string" && envValue.trim() ? envValue.trim() : undefined;
}

export function resolveLlmApiKey(
  config: Pick<OpenAiLlmCallConfig, "apiKey" | "apiKeyEnv">,
): string | undefined {
  const inlineApiKey = config.apiKey?.trim();
  if (inlineApiKey) {
    return inlineApiKey;
  }

  return readEnvValue(config.apiKeyEnv) ?? readEnvValue(DEFAULT_OPENAI_API_KEY_ENV);
}
