function extractTextFromContentBlock(block: unknown): string[] {
  if (!block || typeof block !== "object") {
    return [];
  }
  const value = block as Record<string, unknown>;
  if (value.type === "text" && typeof value.text === "string" && value.text.trim()) {
    return [value.text];
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

export function extractLastAssistantText(messages: unknown[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object") {
      continue;
    }
    const value = message as Record<string, unknown>;
    if (value.role !== "assistant") {
      continue;
    }
    const text = extractMessageTexts(message)
      .map((entry) => entry.trim())
      .filter(Boolean)
      .join("\n\n")
      .trim();
    if (text) {
      return text;
    }
  }
  return undefined;
}
