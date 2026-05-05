const LOG_PREFIX = "Keep-Going Plugin: ";
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
function prefixMessage(message) {
    return `${LOG_PREFIX}${message}`;
}
function sanitizeLogMetadata(meta) {
    if (!meta) {
        return undefined;
    }
    const sanitized = {};
    for (const [key, value] of Object.entries(meta)) {
        sanitized[key] = sanitizeLogValue(key, value);
    }
    return sanitized;
}
function sanitizeLogValue(key, value) {
    if (SENSITIVE_LOG_KEYS.has(key)) {
        return REDACTED_LOG_VALUE;
    }
    if (Array.isArray(value)) {
        return value.map((item) => sanitizeNestedLogValue(item));
    }
    return sanitizeNestedLogValue(value);
}
function sanitizeNestedLogValue(value) {
    if (!value || typeof value !== "object") {
        return value;
    }
    if (Array.isArray(value)) {
        return value.map((item) => sanitizeNestedLogValue(item));
    }
    const sanitized = {};
    for (const [key, nestedValue] of Object.entries(value)) {
        sanitized[key] = sanitizeLogValue(key, nestedValue);
    }
    return sanitized;
}
export function createKeepGoingLogger(logger, debugEnabled) {
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
