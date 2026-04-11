import { normalizeTranscriptMessage } from "../src/messages.js";

export type JsonlEntry = {
  id?: string;
  type?: string;
  timestamp?: string;
  cwd?: string;
  customType?: string;
  data?: {
    runId?: string;
    sessionId?: string;
  };
  message?: unknown;
};

export type CompletedRunSegment = {
  runIndex: number;
  runId: string;
  completedAt?: string;
  entries: JsonlEntry[];
};

export type AssistantRunSummary = {
  messageId?: string;
  timestamp?: string;
  text: string;
};

export function splitIntoCompletedRuns(entries: JsonlEntry[]): CompletedRunSegment[] {
  const segments: CompletedRunSegment[] = [];
  let current: JsonlEntry[] = [];
  let runIndex = 0;

  for (const entry of entries) {
    current.push(entry);
    if (entry.type !== "custom" || entry.customType !== "openclaw:bootstrap-context:full") {
      continue;
    }

    segments.push({
      runIndex,
      runId: entry.data?.runId ?? `fixture-run-${runIndex}`,
      completedAt: entry.timestamp,
      entries: current,
    });
    current = [];
    runIndex += 1;
  }

  return segments;
}

export function messageObjects(entries: JsonlEntry[]): unknown[] {
  return entries
    .filter((entry): entry is JsonlEntry & { type: "message"; message: unknown } => {
      return entry.type === "message" && "message" in entry;
    })
    .map((entry) => entry.message);
}

export function extractLastAssistantRunSummary(
  entries: JsonlEntry[],
): AssistantRunSummary | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "message" || !entry.message) {
      continue;
    }
    const normalized = normalizeTranscriptMessage(entry.message);
    if (normalized?.role !== "assistant") {
      continue;
    }
    return {
      messageId: entry.id,
      timestamp: entry.timestamp,
      text: normalized.text,
    };
  }
  return undefined;
}
