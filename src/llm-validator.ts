import { normalizeTranscriptMessages, type TranscriptMessage } from "./messages.js";
import { normalizeString } from "./normalize.js";
import { callResponsesJsonSchema, resolveLlmApiKey } from "./responses-json-schema.js";
import type {
  ContinuationCandidate,
  ContinuationDecision,
  ContinuationValidationContext,
  KeepGoingLlmValidatorConfig,
} from "./types.js";

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
  "Anchor your decision to the user's requested end state, not just the assistant's last reply.",
  "If the assistant has only completed an intermediate step and still owns an obvious next action needed to satisfy the user's request, return continue=true.",
  "If the assistant explicitly states a remaining concrete next step that it should do now, that is strong evidence for continue=true.",
  "If the assistant just finished an audit, diagnosis, test, or investigation and identified the next repair, implementation, validation, or cleanup step inside the same standing task, default to continue=true.",
  "Do not require the assistant to explicitly say 'next I will' if the remaining work is already clear from the user's request, the current state, and the assistant's own findings.",
  "Treat statements like 'I'd patch that next', 'that's the next thing I'd fix', 'the next fix is clear', 'I'm validating', or 'I'm checking' as evidence of unfinished owned work unless the transcript clearly shows that work was delegated away or blocked.",
  "Do not require a fresh user request when the user is still pursuing the same underlying task and the assistant has enough information to take the next concrete step now.",
  "Treat polite hedge phrases like 'if you want', 'I can', 'I should', 'I still need to', or 'I'll take that next' as likely incomplete work when the assistant identifies a concrete next step inside the same standing task and does not state a real blocker.",
  "If the assistant says the result should be tightened, cleaned up, patched, verified, confirmed, or surfaced properly before the task is really done, that is evidence for continue=true even if phrased as an offer.",
  "If the assistant already delegated the next step to a spawned subagent or child worker, or is waiting on that delegated work, that parent turn should usually be continue=false.",
  "If the assistant says it already sent a subagent, child worker, or separate worker to do the next step, treat the parent turn as continue=false unless the parent also names a separate concrete step that the parent itself still needs to do now.",
  "Do not require the user to re-approve a next step that is already implied by the existing task unless the transcript clearly asks the assistant to stop after the current answer.",
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

export type LlmValidatorOutput = ContinuationDecision & { validatorModel: string };

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

export async function validateContinuationWithLlm(
  input: LlmValidatorInput,
): Promise<LlmValidatorOutput> {
  const apiKey = resolveLlmApiKey(input.config);
  if (!apiKey) {
    throw new Error(
      `missing OpenAI API key for validator; set ${input.config.apiKeyEnv ?? "an apiKey"}`
    );
  }

  const response = await callResponsesJsonSchema(
    {
      config: input.config,
      systemPrompt: VALIDATOR_SYSTEM_PROMPT,
      userPrompt: buildValidatorPrompt(input),
      schemaName: "keep_going_decision",
      schema: CONTINUATION_DECISION_SCHEMA,
      maxOutputTokens: VALIDATOR_MAX_OUTPUT_TOKENS,
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

  return normalizeDecision(parsed, input.config.model);
}
