import { normalizeString } from "./normalize.js";
import type {
  SlackThreadHistoryMessage,
  TranscriptMessage,
  TranscriptMessageRole,
} from "./transcript-types.js";

const SUBAGENT_SPAWN_TOOL_NAMES = new Set(["sessions_spawn", "spawn_subagent"]);
const NO_REPLY_TEXT = "NO_REPLY";
const CONTINUE_PREVIOUS_TASK_TEXT = "Continue the previous task.";
const ASSISTANT_CONTROL_PREFIX = /^\s*(\[\[[^\]]+\]\]\s*)+/;
const THREAD_HISTORY_PREFIX = "[Thread history - for context]";
const SLACK_WRAPPED_USER_PREFIXES = ["[Thread history - for context]", "System:"];
const INTERNAL_USER_TEXT_MARKERS = [
  "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
  "OpenClaw runtime context (internal):",
  "[Internal task completion event]",
];

function isNoReplyAssistantText(value: string): boolean {
  return value.trim().toUpperCase() === NO_REPLY_TEXT;
}

function isSyntheticUserText(value: string): boolean {
  return value.trim() === CONTINUE_PREVIOUS_TASK_TEXT;
}

function isInternalUserText(value: string): boolean {
  return INTERNAL_USER_TEXT_MARKERS.some((marker) => value.includes(marker));
}

function isSlackWrappedUserText(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  return (
    SLACK_WRAPPED_USER_PREFIXES.some((prefix) => trimmed.startsWith(prefix)) ||
    trimmed.includes("Conversation info (untrusted metadata):")
  );
}

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

function readToolCallName(value: Record<string, unknown>): string | undefined {
  const functionValue =
    value.function && typeof value.function === "object"
      ? (value.function as Record<string, unknown>)
      : undefined;

  return (
    normalizeString(functionValue?.name) ??
    normalizeString(value.name) ??
    normalizeString(value.toolName)
  );
}

function collectToolCallNames(message: Record<string, unknown>): string[] {
  const names = new Set<string>();

  const directToolName =
    normalizeString(message.toolName) ??
    normalizeString(message.tool_name) ??
    normalizeString(message.name) ??
    normalizeString(message.tool);
  if (directToolName) {
    names.add(directToolName);
  }

  const toolCalls = message.tool_calls ?? message.toolCalls;
  if (Array.isArray(toolCalls)) {
    for (const entry of toolCalls) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const name = readToolCallName(entry as Record<string, unknown>);
      if (name) {
        names.add(name);
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
    names.add(functionName);
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
        names.add(name);
      }
    }
  }

  return Array.from(names);
}

function extractToolCallTexts(message: Record<string, unknown>): string[] {
  return collectToolCallNames(message).map((name) => `[Tool Call: ${name}]`);
}

function extractToolCallNames(message: Record<string, unknown>): string[] {
  return collectToolCallNames(message).map((name) => name.toLowerCase());
}

function normalizeTranscriptRole(value: unknown): TranscriptMessageRole | undefined {
  if (value === "user" || value === "assistant" || value === "tool" || value === "toolResult") {
    return value;
  }
  return undefined;
}

function normalizeTranscriptMessage(message: unknown): TranscriptMessage | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const value = message as Record<string, unknown>;
  const role = normalizeTranscriptRole(value.role);
  if (!role) {
    return undefined;
  }

  const text = [...extractMessageTexts(message), ...extractToolCallTexts(value)]
    .map((entry) => entry.trim())
    .filter((entry) => role !== "assistant" || !isNoReplyAssistantText(entry))
    .filter(Boolean)
    .join("\n\n")
    .trim();

  if (!text) {
    return undefined;
  }

  return { role, text };
}

export function normalizeTranscriptMessages(messages: unknown[]): TranscriptMessage[] {
  return messages.flatMap((message) => {
    const normalized = normalizeTranscriptMessage(message);
    return normalized ? [normalized] : [];
  });
}

function stripAssistantNonHumanFacingLines(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => !/^\[Tool Call: .+\]$/.test(line.trim()))
    .filter((line) => line.trim() !== "[Tool Result]")
    .join("\n")
    .trim();
}

function normalizeHumanFacingAssistantText(text: string): string | undefined {
  const withoutToolLines = stripAssistantNonHumanFacingLines(text);
  const cleaned = withoutToolLines.replace(ASSISTANT_CONTROL_PREFIX, "").trim();
  return cleaned || undefined;
}

export function normalizeHumanFacingUserText(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed || isSyntheticUserText(trimmed) || isInternalUserText(trimmed)) {
    return undefined;
  }

  if (!isSlackWrappedUserText(trimmed)) {
    return trimmed;
  }

  const fencePattern = /```[\s\S]*?```/g;
  const fences = Array.from(trimmed.matchAll(fencePattern));
  const lastFence = fences.at(-1);
  if (lastFence?.index !== undefined) {
    const tail = trimmed.slice(lastFence.index + lastFence[0].length).trim();
    if (tail && !isSyntheticUserText(tail)) {
      return tail;
    }
  }

  const paragraphs = trimmed
    .split(/\n\s*\n/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const lastParagraph = paragraphs.at(-1);
  if (lastParagraph && !isSyntheticUserText(lastParagraph)) {
    return lastParagraph;
  }

  return undefined;
}

export function extractSlackThreadHistoryMessages(
  text: string,
): SlackThreadHistoryMessage[] {
  const trimmed = text.trim();
  if (!trimmed.startsWith(THREAD_HISTORY_PREFIX)) {
    return [];
  }

  const historyStart = trimmed.slice(THREAD_HISTORY_PREFIX.length).trimStart();
  const systemIndex = historyStart.indexOf("\n\nSystem:");
  const historyOnly = (systemIndex >= 0 ? historyStart.slice(0, systemIndex) : historyStart).trim();
  if (!historyOnly) {
    return [];
  }

  const headerPattern = /\[Slack [^\]]+\((user|assistant)\) [^\]]+\]\s*/g;
  const headers = Array.from(historyOnly.matchAll(headerPattern));
  if (headers.length === 0) {
    return [];
  }

  const messages: SlackThreadHistoryMessage[] = [];
  for (let index = 0; index < headers.length; index += 1) {
    const current = headers[index];
    const next = headers[index + 1];
    if (!current || current.index === undefined) {
      continue;
    }
    const start = current.index + current[0].length;
    const end = next?.index ?? historyOnly.length;
    const rawMessage = historyOnly
      .slice(start, end)
      .replace(/\n?\[slack message id:[^\]]+\]\s*$/i, "")
      .trim();
    if (!rawMessage) {
      continue;
    }
    const role = current[1] === "assistant" ? "assistant" : "user";
    messages.push({ type: role, msg: rawMessage });
  }

  return messages;
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

export function extractLastAssistantHumanFacingText(messages: unknown[]): string | undefined {
  const transcript = normalizeTranscriptMessages(messages);
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const entry = transcript[index];
    if (entry?.role !== "assistant") {
      continue;
    }
    const text = normalizeHumanFacingAssistantText(entry.text);
    if (text) {
      return text;
    }
  }
  return undefined;
}

export function extractLastUserHumanFacingText(messages: unknown[]): string | undefined {
  const transcript = normalizeTranscriptMessages(messages);
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const entry = transcript[index];
    if (entry?.role !== "user") {
      continue;
    }
    const text = normalizeHumanFacingUserText(entry.text);
    if (text) {
      return text;
    }
  }
  return undefined;
}

export function extractInitialSlackThreadHistoryMessages(
  messages: unknown[],
): SlackThreadHistoryMessage[] {
  const transcript = normalizeTranscriptMessages(messages);
  for (const entry of transcript) {
    if (entry.role !== "user") {
      continue;
    }
    const historyMessages = extractSlackThreadHistoryMessages(entry.text);
    if (historyMessages.length > 0) {
      return historyMessages;
    }
  }
  return [];
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
