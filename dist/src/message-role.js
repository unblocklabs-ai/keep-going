export function readMessageRole(message) {
    if (!message || typeof message !== "object") {
        return undefined;
    }
    const role = message.role;
    return typeof role === "string" ? role : undefined;
}
export function isConversationMessage(message) {
    const role = readMessageRole(message);
    return role === "user" || role === "assistant";
}
