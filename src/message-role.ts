export function readMessageRole(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }

  const role = (message as { role?: unknown }).role;
  return typeof role === "string" ? role : undefined;
}

export function isConversationMessage(message: unknown): boolean {
  const role = readMessageRole(message);
  return role === "user" || role === "assistant";
}
