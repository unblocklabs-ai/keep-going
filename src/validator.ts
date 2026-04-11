import { extractLastAssistantText } from "./messages.js";
import type { ContinuationCandidate, ContinuationDecision } from "./types.js";

const POSITIVE_PATTERNS = [
  /\bnext i need to\b/i,
  /\bi still need to\b/i,
  /\bstill need to\b/i,
  /\bremaining step\b/i,
  /\bi need to update\b/i,
  /\bi need to run\b/i,
  /\bnext step\b/i,
  /\bcontinue by\b/i,
];

const COMPLETE_PATTERNS = [
  /\b(task|work|implementation|changes?) (is|are) complete\b/i,
  /\b(done|finished|complete)\b/i,
  /\bno further action\b/i,
];

const BLOCKED_PATTERNS = [
  /\bblocked\b/i,
  /\bwaiting on\b/i,
  /\bneed approval\b/i,
  /\bmissing (access|permission|information|details)\b/i,
];

export function validateContinuation(candidate: ContinuationCandidate): ContinuationDecision {
  if (!candidate.success) {
    return {
      continue: false,
      reason: "run-unsuccessful",
    };
  }

  const lastAssistantText = extractLastAssistantText(candidate.messages);
  if (!lastAssistantText) {
    return {
      continue: false,
      reason: "no-assistant-text",
    };
  }

  if (BLOCKED_PATTERNS.some((pattern) => pattern.test(lastAssistantText))) {
    return {
      continue: false,
      reason: "assistant-blocked",
    };
  }

  const hasPositiveSignal = POSITIVE_PATTERNS.some((pattern) => pattern.test(lastAssistantText));
  const hasCompleteSignal = COMPLETE_PATTERNS.some((pattern) => pattern.test(lastAssistantText));

  if (!hasPositiveSignal) {
    return {
      continue: false,
      reason: "no-unfinished-signal",
    };
  }

  if (hasCompleteSignal && !/\bnext i need to\b/i.test(lastAssistantText)) {
    return {
      continue: false,
      reason: "assistant-marked-complete",
    };
  }

  return {
    continue: true,
    reason: "unfinished-language-detected",
    followUpInstruction:
      "Do the next remaining actionable step now unless the task is already complete or truly blocked.",
  };
}
