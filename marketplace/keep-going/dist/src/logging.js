const LOG_PREFIX = "Keep-Going Plugin: ";
function prefixMessage(message) {
    return `${LOG_PREFIX}${message}`;
}
export function createKeepGoingLogger(logger, debugEnabled) {
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
