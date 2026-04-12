import type { OpenAiLlmCallConfig } from "./types.js";

export function resolveLlmApiKey(
  config: Pick<OpenAiLlmCallConfig, "apiKey" | "apiKeyEnv">,
): string | undefined {
  const inlineApiKey = config.apiKey?.trim();
  if (inlineApiKey) {
    return inlineApiKey;
  }

  const envKeyName = config.apiKeyEnv?.trim();
  if (!envKeyName) {
    return undefined;
  }

  const envValue = process.env[envKeyName];
  return typeof envValue === "string" && envValue.trim() ? envValue.trim() : undefined;
}
