import { normalizeString } from "./normalize.js";
import type { KeepGoingLlmValidatorConfig } from "./types.js";

const OPENAI_RESPONSES_API_URL = "https://api.openai.com/v1/responses";

type ResponsesApiOutputBlock = {
  type?: unknown;
  text?: unknown;
  refusal?: unknown;
};

type ResponsesApiOutputItem = {
  type?: unknown;
  content?: unknown;
};

type ResponsesJsonSchemaRequest = {
  config: KeepGoingLlmValidatorConfig;
  systemPrompt: string;
  userPrompt: string;
  schemaName: string;
  schema: object;
  maxOutputTokens?: number;
};

type ResponsesJsonSchemaResult = {
  outputText?: string;
  refusal?: string;
};

function clipText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return value.slice(0, Math.max(0, maxChars - 1)).trimEnd() + "…";
}

function extractOutputText(responseBody: unknown): string | undefined {
  if (!responseBody || typeof responseBody !== "object") {
    return undefined;
  }
  const body = responseBody as Record<string, unknown>;
  const topLevelText = normalizeString(body.output_text);
  if (topLevelText) {
    return topLevelText;
  }

  const output = Array.isArray(body.output) ? (body.output as ResponsesApiOutputItem[]) : [];
  const blocks: string[] = [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? (item.content as ResponsesApiOutputBlock[]) : [];
    for (const block of content) {
      const text = normalizeString(block?.text) ?? normalizeString(block?.refusal);
      if (text) {
        blocks.push(text);
      }
    }
  }

  const combined = blocks.join("\n").trim();
  return combined || undefined;
}

function extractRefusalText(responseBody: unknown): string | undefined {
  if (!responseBody || typeof responseBody !== "object") {
    return undefined;
  }
  const body = responseBody as Record<string, unknown>;
  const output = Array.isArray(body.output) ? (body.output as ResponsesApiOutputItem[]) : [];
  const refusals: string[] = [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? (item.content as ResponsesApiOutputBlock[]) : [];
    for (const block of content) {
      if (block?.type === "refusal") {
        const refusal = normalizeString(block.refusal);
        if (refusal) {
          refusals.push(refusal);
        }
      }
    }
  }
  const combined = refusals.join("\n").trim();
  return combined || undefined;
}

export function resolveLlmApiKey(
  config: Pick<KeepGoingLlmValidatorConfig, "apiKey" | "apiKeyEnv">,
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

export async function callResponsesJsonSchema(
  request: ResponsesJsonSchemaRequest,
  apiKey: string,
): Promise<ResponsesJsonSchemaResult> {
  const controller = new AbortController();
  const timeoutMs = request.config.timeoutMs ?? 15_000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(OPENAI_RESPONSES_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: request.config.model,
        store: false,
        temperature: request.config.temperature ?? 0,
        max_output_tokens: request.maxOutputTokens ?? 400,
        input: [
          {
            role: "system",
            content: [{ type: "input_text", text: request.systemPrompt }],
          },
          {
            role: "user",
            content: [{ type: "input_text", text: request.userPrompt }],
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: request.schemaName,
            strict: true,
            schema: request.schema,
          },
        },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const responseText = clipText(await response.text(), 1000);
      throw new Error(
        `request failed with ${response.status} ${response.statusText}: ${responseText}`,
      );
    }

    const responseBody = await response.json();
    return {
      outputText: extractOutputText(responseBody),
      refusal: extractRefusalText(responseBody),
    };
  } finally {
    clearTimeout(timeout);
  }
}
