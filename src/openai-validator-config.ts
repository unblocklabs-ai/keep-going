import type { KeepGoingLlmValidatorConfig } from "./types.js";

export const DEFAULT_OPENAI_VALIDATOR_MODEL = "gpt-5.4-mini";
export const DEFAULT_OPENAI_API_KEY_ENV = "KEEP_GOING_OPENAI_API_KEY";

type OpenAiValidatorConfigOptions = {
  model?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  maxMessages: number;
  maxChars: number;
  includeCurrentTurnOnly: boolean;
  recentUserMessages: number;
  temperature?: number;
  timeoutMs?: number;
};

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function createOpenAiValidatorConfig(
  options: OpenAiValidatorConfigOptions,
): KeepGoingLlmValidatorConfig {
  return {
    provider: "openai",
    model: normalizeOptionalString(options.model) ?? DEFAULT_OPENAI_VALIDATOR_MODEL,
    apiKey: normalizeOptionalString(options.apiKey),
    apiKeyEnv:
      normalizeOptionalString(options.apiKeyEnv) ?? DEFAULT_OPENAI_API_KEY_ENV,
    maxMessages: options.maxMessages,
    maxChars: options.maxChars,
    includeCurrentTurnOnly: options.includeCurrentTurnOnly,
    recentUserMessages: options.recentUserMessages,
    temperature: options.temperature ?? 0,
    timeoutMs: options.timeoutMs,
  };
}
