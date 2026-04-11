import { normalizeTranscriptMessages, type TranscriptMessage } from "./messages.js";
import { normalizeString } from "./normalize.js";
import type {
  ContinuationCandidate,
  ContinuationDecision,
  ContinuationValidationContext,
  KeepGoingLlmValidatorConfig,
} from "./types.js";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const VALIDATOR_MAX_OUTPUT_TOKENS = 400;

const CONTINUATION_DECISION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    continue: { type: "boolean" },
    reason: { type: "string" },
    follow_up_instruction: { type: "string" },
  },
  required: ["continue", "reason", "follow_up_instruction"],
} as const;

const VALIDATOR_SYSTEM_PROMPT = [
  "You are a completion validator for a coding agent.",
  "Your job is to decide whether the agent's just-finished turn should immediately continue in a follow-up run.",
  "Return continue=true only when there is clearly remaining actionable work the same agent should do now without waiting for the user.",
  "Return continue=false when the work appears complete, the agent is truly blocked, or the next step requires new user input or approval.",
  "If the assistant explicitly states a remaining concrete next step that it should do now, that is strong evidence for continue=true.",
  "Do not treat optional future ideas, stretch goals, or vague improvements as incomplete work.",
  "If continue=true, provide a short follow_up_instruction telling the agent what remaining step to do next.",
  "If continue=false, set follow_up_instruction to an empty string.",
  "Be conservative about continuing when the transcript shows a real blocker.",
].join("\n");

export type LlmValidatorInput = {
  candidate: ContinuationCandidate;
  config: KeepGoingLlmValidatorConfig;
  context?: ContinuationValidationContext;
};

export type LlmValidatorOutput = ContinuationDecision & {
  validatorModel: string;
};

type ResponsesApiOutputBlock = {
  type?: unknown;
  text?: unknown;
  refusal?: unknown;
};

type ResponsesApiOutputItem = {
  type?: unknown;
  content?: unknown;
};

function clipText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return value.slice(0, Math.max(0, maxChars - 1)).trimEnd() + "…";
}

function buildCurrentTurnWindow(
  messages: TranscriptMessage[],
  includeCurrentTurnOnly: boolean,
): TranscriptMessage[] {
  if (!includeCurrentTurnOnly) {
    return messages;
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      return messages.slice(index);
    }
  }
  return messages;
}

function roleLabel(role: TranscriptMessage["role"]): string {
  switch (role) {
    case "tool":
      return "TOOL";
    case "toolResult":
      return "TOOL_RESULT";
    default:
      return role.toUpperCase();
  }
}

function renderTranscriptWindow(
  messages: TranscriptMessage[],
  maxMessages: number,
  maxChars: number,
): string {
  const selected = messages.slice(-maxMessages);
  const rendered = selected
    .map((message) => `${roleLabel(message.role)}:\n${message.text.trim()}`)
    .filter(Boolean);

  const kept: string[] = [];
  let totalChars = 0;
  for (let index = rendered.length - 1; index >= 0; index -= 1) {
    const block = rendered[index];
    const candidateChars = totalChars + block.length + (kept.length > 0 ? 2 : 0);
    if (candidateChars > maxChars) {
      if (kept.length === 0) {
        kept.unshift(clipText(block, maxChars));
      }
      break;
    }
    kept.unshift(block);
    totalChars = candidateChars;
  }

  return kept.join("\n\n").trim();
}

function buildValidatorPrompt(input: LlmValidatorInput): string {
  const runTranscriptMessages = input.context?.runTranscriptMessages ?? [];
  const messages =
    input.config.includeCurrentTurnOnly && runTranscriptMessages.length > 0
      ? runTranscriptMessages
      : normalizeTranscriptMessages(input.candidate.messages);
  const turnWindow =
    input.config.includeCurrentTurnOnly && runTranscriptMessages.length > 0
      ? runTranscriptMessages
      : buildCurrentTurnWindow(messages, input.config.includeCurrentTurnOnly);
  const transcript = renderTranscriptWindow(
    turnWindow,
    input.config.maxMessages,
    input.config.maxChars,
  );

  return [
    "Decide whether the plugin should start a same-session follow-up run for this completed turn.",
    "",
    `Run ID: ${input.candidate.runId}`,
    `Current turn only: ${input.config.includeCurrentTurnOnly ? "yes" : "no"}`,
    "",
    "Transcript:",
    transcript || "[No transcript text available]",
  ].join("\n");
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

function normalizeDecision(
  parsed: unknown,
  fallbackModel: string,
): LlmValidatorOutput {
  if (!parsed || typeof parsed !== "object") {
    throw new Error("validator returned a non-object response");
  }

  const value = parsed as Record<string, unknown>;
  if (typeof value.continue !== "boolean") {
    throw new Error("validator response is missing boolean continue");
  }

  const reason = normalizeString(value.reason);
  if (!reason) {
    throw new Error("validator response is missing reason");
  }

  const followUpInstruction = normalizeString(value.follow_up_instruction) ?? "";

  return {
    continue: value.continue,
    reason,
    followUpInstruction: followUpInstruction || undefined,
    validatorModel: fallbackModel,
  };
}

async function callOpenAiValidator(input: LlmValidatorInput, apiKey: string): Promise<unknown> {
  const controller = new AbortController();
  const timeoutMs = input.config.timeoutMs ?? 15_000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: input.config.model,
        store: false,
        temperature: input.config.temperature ?? 0,
        max_output_tokens: VALIDATOR_MAX_OUTPUT_TOKENS,
        input: [
          {
            role: "system",
            content: [{ type: "input_text", text: VALIDATOR_SYSTEM_PROMPT }],
          },
          {
            role: "user",
            content: [{ type: "input_text", text: buildValidatorPrompt(input) }],
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "keep_going_decision",
            strict: true,
            schema: CONTINUATION_DECISION_SCHEMA,
          },
        },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const responseText = clipText(await response.text(), 1000);
      throw new Error(
        `validator request failed with ${response.status} ${response.statusText}: ${responseText}`,
      );
    }

    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

export function resolveLlmValidatorApiKey(
  config: KeepGoingLlmValidatorConfig,
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

export async function validateContinuationWithLlm(
  input: LlmValidatorInput,
): Promise<LlmValidatorOutput> {
  if (input.config.provider !== "openai") {
    throw new Error(`unsupported llm validator provider: ${input.config.provider}`);
  }

  const apiKey = resolveLlmValidatorApiKey(input.config);
  if (!apiKey) {
    throw new Error(
      `missing OpenAI API key for validator; set ${input.config.apiKeyEnv ?? "an apiKey"}`
    );
  }

  const responseBody = await callOpenAiValidator(input, apiKey);
  const refusal = extractRefusalText(responseBody);
  if (refusal) {
    return {
      continue: false,
      reason: "validator-refused",
      validatorModel: input.config.model,
    };
  }

  const outputText = extractOutputText(responseBody);
  if (!outputText) {
    throw new Error("validator response did not include output text");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(outputText);
  } catch (error) {
    throw new Error(
      `validator returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  return normalizeDecision(parsed, input.config.model);
}
