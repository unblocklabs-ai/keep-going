import type { RuntimeLogger } from "openclaw/plugin-sdk";

const LOG_PREFIX = "Keep-Going Plugin: ";

export type KeepGoingLogger = {
  debugEnabled: boolean;
  step: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
};

function prefixMessage(message: string): string {
  return `${LOG_PREFIX}${message}`;
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
      logger.info(prefixMessage(message), meta);
    },
    error(message, meta) {
      logger.error(prefixMessage(message), meta);
    },
  };
}
