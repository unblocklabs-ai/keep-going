import { normalizeString } from "./normalize.js";
export function resolveBaseSessionKey(sessionKey) {
    const marker = ":thread:";
    const markerIndex = sessionKey.lastIndexOf(marker);
    if (markerIndex < 0) {
        return sessionKey;
    }
    return sessionKey.slice(0, markerIndex);
}
function normalizeTrackingSessionKey(sessionKey) {
    return resolveBaseSessionKey(sessionKey.trim());
}
export function normalizeOptionalTrackingSessionKey(sessionKey) {
    const normalized = normalizeString(sessionKey);
    return normalized ? normalizeTrackingSessionKey(normalized) : undefined;
}
