import type { RuntimeLogger } from "openclaw/plugin-sdk/core";

const LOG_PREFIX = "Keep-Going Plugin: ";

export type KeepGoingLogger = {
  debugEnabled: boolean;
  step: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
};

const REDACTED_LOG_VALUE = "[redacted]";
const SENSITIVE_LOG_KEYS = new Set([
  "content",
  "followUpInstruction",
  "message",
  "messages",
  "prompt",
  "reason",
  "text",
  "transcript",
  "transcriptPrompt",
]);

function prefixMessage(message: string): string {
  return `${LOG_PREFIX}${message}`;
}

function sanitizeLogMetadata(meta: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!meta) {
    return undefined;
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    sanitized[key] = sanitizeLogValue(key, value);
  }
  return sanitized;
}

function sanitizeLogValue(key: string, value: unknown): unknown {
  if (SENSITIVE_LOG_KEYS.has(key)) {
    return REDACTED_LOG_VALUE;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeNestedLogValue(item));
  }
  return sanitizeNestedLogValue(value);
}

function sanitizeNestedLogValue(value: unknown): unknown {
  if (!value || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeNestedLogValue(item));
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    sanitized[key] = sanitizeLogValue(key, nestedValue);
  }
  return sanitized;
}

export function createKeepGoingLogger(
  logger: RuntimeLogger,
  debugEnabled: boolean,
): KeepGoingLogger {
  return {
    debugEnabled,
    step(message, meta) {
      if (!debugEnabled) {
        return;
      }
      logger.info(prefixMessage(message), sanitizeLogMetadata(meta));
    },
    error(message, meta) {
      logger.error(prefixMessage(message), sanitizeLogMetadata(meta));
    },
  };
}
