import { normalizeString } from "./normalize.js";

export type TranscriptMessageRole = "user" | "assistant" | "tool" | "toolResult";

export type TranscriptMessage = {
  role: TranscriptMessageRole;
  text: string;
};

const SUBAGENT_SPAWN_TOOL_NAMES = new Set(["sessions_spawn", "spawn_subagent"]);

function extractTextFromContentBlock(block: unknown): string[] {
  if (!block || typeof block !== "object") {
    return [];
  }
  const value = block as Record<string, unknown>;
  if (
    (value.type === "text" ||
      value.type === "input_text" ||
      value.type === "output_text") &&
    typeof value.text === "string" &&
    value.text.trim()
  ) {
    return [value.text];
  }
  if (typeof value.text === "string" && value.text.trim()) {
    return [value.text];
  }
  if (typeof value.refusal === "string" && value.refusal.trim()) {
    return [value.refusal];
  }
  const blockType = normalizeString(value.type)?.toLowerCase();
  if (blockType === "tool_use" || blockType === "tooluse" || blockType === "tool_call" || blockType === "toolcall") {
    return [`[Tool Call: ${normalizeString(value.name) ?? "tool"}]`];
  }
  if (blockType === "tool_result" || blockType === "toolresult") {
    const resultTexts = Array.isArray(value.content)
      ? value.content.flatMap(extractTextFromContentBlock)
      : [];
    return ["[Tool Result]", ...resultTexts];
  }
  return [];
}

function extractMessageTexts(message: unknown): string[] {
  if (!message || typeof message !== "object") {
    return [];
  }
  const value = message as Record<string, unknown>;
  const content = value.content;
  if (typeof content === "string" && content.trim()) {
    return [content];
  }
  if (Array.isArray(content)) {
    return content.flatMap(extractTextFromContentBlock);
  }
  return [];
}

function extractToolCallTexts(message: Record<string, unknown>): string[] {
  const values: string[] = [];
  const toolCalls = message.tool_calls ?? message.toolCalls;
  if (Array.isArray(toolCalls)) {
    for (const entry of toolCalls) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const value = entry as Record<string, unknown>;
      const functionValue =
        value.function && typeof value.function === "object"
          ? (value.function as Record<string, unknown>)
          : undefined;
      const name =
        normalizeString(functionValue?.name) ??
        normalizeString(value.name) ??
        normalizeString(value.toolName);
      if (name) {
        values.push(`[Tool Call: ${name}]`);
      }
    }
  }

  const functionCall =
    message.function_call && typeof message.function_call === "object"
      ? (message.function_call as Record<string, unknown>)
      : message.functionCall && typeof message.functionCall === "object"
        ? (message.functionCall as Record<string, unknown>)
        : undefined;
  const functionName = normalizeString(functionCall?.name);
  if (functionName) {
    values.push(`[Tool Call: ${functionName}]`);
  }

  return values;
}

function extractToolCallNames(message: Record<string, unknown>): string[] {
  const names = new Set<string>();

  const directToolName =
    normalizeString(message.toolName) ??
    normalizeString(message.tool_name) ??
    normalizeString(message.name) ??
    normalizeString(message.tool);
  if (directToolName) {
    names.add(directToolName.toLowerCase());
  }

  const toolCalls = message.tool_calls ?? message.toolCalls;
  if (Array.isArray(toolCalls)) {
    for (const entry of toolCalls) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const value = entry as Record<string, unknown>;
      const functionValue =
        value.function && typeof value.function === "object"
          ? (value.function as Record<string, unknown>)
          : undefined;
      const name =
        normalizeString(functionValue?.name) ??
        normalizeString(value.name) ??
        normalizeString(value.toolName);
      if (name) {
        names.add(name.toLowerCase());
      }
    }
  }

  const functionCall =
    message.function_call && typeof message.function_call === "object"
      ? (message.function_call as Record<string, unknown>)
      : message.functionCall && typeof message.functionCall === "object"
        ? (message.functionCall as Record<string, unknown>)
        : undefined;
  const functionName = normalizeString(functionCall?.name);
  if (functionName) {
    names.add(functionName.toLowerCase());
  }

  const content = message.content;
  if (Array.isArray(content)) {
    for (const entry of content) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const value = entry as Record<string, unknown>;
      const blockType = normalizeString(value.type)?.toLowerCase();
      if (
        blockType !== "tool_use" &&
        blockType !== "tooluse" &&
        blockType !== "tool_call" &&
        blockType !== "toolcall"
      ) {
        continue;
      }
      const name = normalizeString(value.name);
      if (name) {
        names.add(name.toLowerCase());
      }
    }
  }

  return Array.from(names);
}

function normalizeTranscriptRole(value: unknown): TranscriptMessageRole | undefined {
  if (value === "user" || value === "assistant" || value === "tool" || value === "toolResult") {
    return value;
  }
  return undefined;
}

export function normalizeTranscriptMessages(messages: unknown[]): TranscriptMessage[] {
  return messages.flatMap((message) => {
    if (!message || typeof message !== "object") {
      return [];
    }
    const value = message as Record<string, unknown>;
    const role = normalizeTranscriptRole(value.role);
    if (!role) {
      return [];
    }

    const text = [...extractMessageTexts(message), ...extractToolCallTexts(value)]
      .map((entry) => entry.trim())
      .filter(Boolean)
      .join("\n\n")
      .trim();

    if (!text) {
      return [];
    }

    return [{ role, text }];
  });
}

export function extractLastAssistantText(messages: unknown[]): string | undefined {
  const transcript = normalizeTranscriptMessages(messages);
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const entry = transcript[index];
    if (entry?.role !== "assistant") {
      continue;
    }
    const text = entry.text.trim();
    if (text) {
      return text;
    }
  }
  return undefined;
}

export function lastAssistantHasSubagentSpawnToolCall(messages: unknown[]): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object") {
      continue;
    }
    const value = message as Record<string, unknown>;
    if (value.role !== "assistant") {
      continue;
    }
    const names = extractToolCallNames(value);
    return names.some((name) => SUBAGENT_SPAWN_TOOL_NAMES.has(name));
  }
  return false;
}
