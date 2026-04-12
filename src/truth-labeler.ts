import type { OpenAiLlmCallConfig } from "./types.js";
import { callResponsesJsonSchema, resolveLlmApiKey } from "./responses-json-schema.js";

const TRUTH_LABEL_MAX_OUTPUT_TOKENS = 500;

const TRUTH_LABEL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    continue_fact: { type: "boolean" },
    reason: { type: "string" },
    notes: { type: "string" },
  },
  required: ["continue_fact", "reason", "notes"],
} as const;

const TRUTH_LABEL_SYSTEM_PROMPT = [
  "You are labeling whether a just-finished assistant turn should have continued automatically in an async-worker setting.",
  "Use the full session transcript up to and including the assistant turn being labeled.",
  "Return continue_fact=true when the same assistant should have kept working without waiting for the user.",
  "Return continue_fact=false when the work was actually complete, truly blocked, explicitly delegated away, or correctly waiting on another worker/subagent.",
  "Anchor your decision to the user's requested end state, not just the assistant's final sentence.",
  "If the assistant only completed an intermediate step and still owned an obvious next action, return continue_fact=true.",
  "If the assistant explicitly handed off the next step to a subagent or other worker, return continue_fact=false for the parent turn unless the parent still had its own separate concrete next action.",
  "Treat diagnostic, audit, investigation, and test turns as incomplete when they clearly expose the next fix and that fix is still owned by the same assistant.",
  "Use reason for the core judgment. Use notes for a short reviewer-oriented explanation.",
].join("\n");

export type TruthLabelInput = {
  config: OpenAiLlmCallConfig;
  prompt: string;
};

export type TruthLabelOutput = {
  continueFact: boolean;
  reason: string;
  notes: string;
  labelModel: string;
};

export async function labelTruthWithLlm(input: TruthLabelInput): Promise<TruthLabelOutput> {
  const apiKey = resolveLlmApiKey(input.config);
  if (!apiKey) {
    throw new Error(
      `missing OpenAI API key for truth labeler; set ${input.config.apiKeyEnv ?? "an apiKey"}`,
    );
  }

  const response = await callResponsesJsonSchema(
    {
      config: input.config,
      systemPrompt: TRUTH_LABEL_SYSTEM_PROMPT,
      userPrompt: input.prompt,
      schemaName: "keep_going_truth_label",
      schema: TRUTH_LABEL_SCHEMA,
      maxOutputTokens: TRUTH_LABEL_MAX_OUTPUT_TOKENS,
    },
    apiKey,
  );

  if (response.refusal) {
    throw new Error(`truth labeler refused: ${response.refusal}`);
  }

  if (!response.outputText) {
    throw new Error("truth labeler response did not include output text");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(response.outputText);
  } catch (error) {
    throw new Error(
      `truth labeler returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("truth labeler returned a non-object response");
  }

  const value = parsed as Record<string, unknown>;
  if (typeof value.continue_fact !== "boolean") {
    throw new Error("truth labeler response is missing boolean continue_fact");
  }
  if (typeof value.reason !== "string" || !value.reason.trim()) {
    throw new Error("truth labeler response is missing reason");
  }
  if (typeof value.notes !== "string") {
    throw new Error("truth labeler response is missing notes");
  }

  return {
    continueFact: value.continue_fact,
    reason: value.reason.trim(),
    notes: value.notes.trim(),
    labelModel: input.config.model,
  };
}
