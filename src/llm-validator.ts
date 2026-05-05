import { normalizeTranscriptMessages } from "./messages.js";
import { normalizeString } from "./normalize.js";
import { resolveLlmApiKey } from "./openai-api-key.js";
import { OPENAI_VALIDATOR_INTERNAL_DEFAULTS } from "./openai-validator-config.js";
import { callResponsesJsonSchema } from "./responses-json-schema.js";
import type { KeepGoingLogger } from "./logging.js";
import type { TranscriptMessage } from "./transcript-types.js";
import type {
  ContinuationCandidate,
  ContinuationDecision,
  ContinuationValidationContext,
  KeepGoingLlmValidatorConfig,
} from "./types.js";

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

type LlmValidatorInput = {
  candidate: ContinuationCandidate;
  config: KeepGoingLlmValidatorConfig;
  context?: ContinuationValidationContext;
  logger?: KeepGoingLogger;
  runtimeConfig?: Parameters<typeof resolveLlmApiKey>[1];
};

type LlmValidatorOutput = ContinuationDecision & { validatorModel: string };

type ParsedContinuationDecision = {
  continue: boolean;
  reason?: unknown;
  follow_up_instruction?: unknown;
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

function isToolCallLine(value: string): boolean {
  return /^\[Tool Call: .+\]$/.test(value.trim());
}

function stripAssistantToolCallNoise(message: TranscriptMessage): TranscriptMessage | undefined {
  if (message.role !== "assistant") {
    return message;
  }

  const cleaned = message.text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => !isToolCallLine(line))
    .join("\n")
    .trim();

  if (!cleaned) {
    return undefined;
  }

  return {
    role: "assistant",
    text: cleaned,
  };
}

function buildRecentContextWithCurrentTurn(
  sessionMessages: TranscriptMessage[],
  runMessages: TranscriptMessage[],
  recentUserMessages: number,
): TranscriptMessage[] {
  if (sessionMessages.length === 0) {
    return runMessages.length > 0 ? runMessages : [];
  }

  const userIndexes: number[] = [];
  for (let index = 0; index < sessionMessages.length; index += 1) {
    if (sessionMessages[index]?.role === "user") {
      userIndexes.push(index);
    }
  }

  if (userIndexes.length === 0) {
    return runMessages.length > 0 ? runMessages : buildCurrentTurnWindow(sessionMessages, true);
  }

  const selectedUserIndexes = userIndexes.slice(-Math.max(1, recentUserMessages));
  const currentTurnStartIndex = selectedUserIndexes[selectedUserIndexes.length - 1] ?? userIndexes[userIndexes.length - 1] ?? 0;
  const context: TranscriptMessage[] = [];

  for (let index = 0; index < selectedUserIndexes.length - 1; index += 1) {
    const userIndex = selectedUserIndexes[index] ?? 0;
    const nextUserIndex = selectedUserIndexes[index + 1] ?? sessionMessages.length;
    const userMessage = sessionMessages[userIndex];
    if (userMessage) {
      context.push(userMessage);
    }

    let finalAssistant: TranscriptMessage | undefined;
    for (let inner = nextUserIndex - 1; inner > userIndex; inner -= 1) {
      const candidate = sessionMessages[inner];
      if (candidate?.role !== "assistant") {
        continue;
      }
      finalAssistant = stripAssistantToolCallNoise(candidate);
      if (finalAssistant) {
        break;
      }
    }

    if (finalAssistant) {
      context.push(finalAssistant);
    }
  }

  const currentTurnMessages =
    runMessages.length > 0 ? runMessages : sessionMessages.slice(currentTurnStartIndex);
  return [...context, ...currentTurnMessages];
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

export function buildValidatorPrompt(input: LlmValidatorInput): string {
  const runTranscriptMessages = input.context?.runTranscriptMessages ?? [];
  const sessionTranscriptMessages = input.context?.sessionTranscriptMessages ?? [];
  const candidateTranscriptMessages = normalizeTranscriptMessages(input.candidate.messages);
  const transcriptSource =
    sessionTranscriptMessages.length > 0
      ? sessionTranscriptMessages
      : runTranscriptMessages.length > 0
        ? runTranscriptMessages
        : candidateTranscriptMessages;
  const transcriptWindow = input.config.includeCurrentTurnOnly
    ? sessionTranscriptMessages.length > 0
      ? buildRecentContextWithCurrentTurn(
          sessionTranscriptMessages,
          runTranscriptMessages,
          input.config.recentUserMessages,
        )
      : runTranscriptMessages.length > 0
        ? runTranscriptMessages
        : buildCurrentTurnWindow(candidateTranscriptMessages, true)
    : transcriptSource;
  const transcript = renderTranscriptWindow(
    transcriptWindow,
    input.config.maxMessages,
    input.config.maxChars,
  );

  return [
    "Decide whether the plugin should start a same-session follow-up run for this completed turn.",
    "",
    `Run ID: ${input.candidate.runId}`,
    `Conversation scope: ${
      input.config.includeCurrentTurnOnly
        ? `current work plus up to ${input.config.recentUserMessages} recent user turns`
        : "full available session history"
    }`,
    "",
    "Transcript:",
    transcript || "[No transcript text available]",
  ].join("\n");
}

function normalizeDecision(
  parsed: unknown,
  fallbackModel: string,
): LlmValidatorOutput {
  if (!parsed || typeof parsed !== "object") {
    throw new Error("validator returned a non-object response");
  }

  const value = parsed as ParsedContinuationDecision;
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

export async function validateContinuationWithLlm(
  input: LlmValidatorInput,
): Promise<LlmValidatorOutput> {
  const apiKey = resolveLlmApiKey(input.config, input.runtimeConfig);
  if (!apiKey) {
    const configuredEnv = input.config.apiKeyEnv?.trim();
    const envHint = configuredEnv && configuredEnv !== "OPENAI_API_KEY"
      ? `${configuredEnv} or OPENAI_API_KEY`
      : "OPENAI_API_KEY";
    throw new Error(
      `missing OpenAI API key for validator; set ${envHint}`
    );
  }

  input.logger?.step("preparing validator input", {
    runId: input.candidate.runId,
    sessionKey: input.candidate.sessionKey,
    model: input.config.model,
    includeCurrentTurnOnly: input.config.includeCurrentTurnOnly,
    recentUserMessages: input.config.recentUserMessages,
    candidateMessageCount: input.candidate.messages.length,
    runTranscriptMessageCount: input.context?.runTranscriptMessages?.length ?? 0,
    sessionTranscriptMessageCount: input.context?.sessionTranscriptMessages?.length ?? 0,
  });

  const response = await callResponsesJsonSchema(
    {
      config: input.config,
      systemPrompt: input.config.systemPrompt,
      userPrompt: buildValidatorPrompt(input),
      schemaName: "keep_going_decision",
      schema: CONTINUATION_DECISION_SCHEMA,
      maxOutputTokens: OPENAI_VALIDATOR_INTERNAL_DEFAULTS.maxOutputTokens,
      logger: input.logger,
    },
    apiKey,
  );
  const refusal = response.refusal;
  if (refusal) {
    return {
      continue: false,
      reason: "validator-refused",
      validatorModel: input.config.model,
    };
  }

  const outputText = response.outputText;
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

  const decision = normalizeDecision(parsed, input.config.model);
  input.logger?.step("validator JSON parsed", {
    runId: input.candidate.runId,
    sessionKey: input.candidate.sessionKey,
    continue: decision.continue,
    reason: decision.reason,
    hasFollowUpInstruction: Boolean(decision.followUpInstruction),
    validatorModel: decision.validatorModel,
  });

  return decision;
}
