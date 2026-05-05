import { normalizeTranscriptMessages } from "./messages.js";
import { normalizeString } from "./normalize.js";
import { resolveLlmApiKey } from "./openai-api-key.js";
import { OPENAI_VALIDATOR_INTERNAL_DEFAULTS } from "./openai-validator-config.js";
import { callResponsesJsonSchema } from "./responses-json-schema.js";
const CONTINUATION_DECISION_SCHEMA = {
    type: "object",
    additionalProperties: false,
    properties: {
        continue: { type: "boolean" },
        reason: { type: "string" },
        follow_up_instruction: { type: "string" },
    },
    required: ["continue", "reason", "follow_up_instruction"],
};
function clipText(value, maxChars) {
    if (value.length <= maxChars) {
        return value;
    }
    return value.slice(0, Math.max(0, maxChars - 1)).trimEnd() + "…";
}
function buildCurrentTurnWindow(messages, includeCurrentTurnOnly) {
    if (!includeCurrentTurnOnly) {
        return messages;
    }
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index]?.role === "user") {
            return messages.slice(index);
        }
    }
    return messages;
}
function isToolCallLine(value) {
    return /^\[Tool Call: .+\]$/.test(value.trim());
}
function stripAssistantToolCallNoise(message) {
    if (message.role !== "assistant") {
        return message;
    }
    const cleaned = message.text
        .split("\n")
        .map((line) => line.trimEnd())
        .filter((line) => !isToolCallLine(line))
        .join("\n")
        .trim();
    if (!cleaned) {
        return undefined;
    }
    return {
        role: "assistant",
        text: cleaned,
    };
}
function buildRecentContextWithCurrentTurn(sessionMessages, runMessages, recentUserMessages) {
    if (sessionMessages.length === 0) {
        return runMessages.length > 0 ? runMessages : [];
    }
    const userIndexes = [];
    for (let index = 0; index < sessionMessages.length; index += 1) {
        if (sessionMessages[index]?.role === "user") {
            userIndexes.push(index);
        }
    }
    if (userIndexes.length === 0) {
        return runMessages.length > 0 ? runMessages : buildCurrentTurnWindow(sessionMessages, true);
    }
    const selectedUserIndexes = userIndexes.slice(-Math.max(1, recentUserMessages));
    const currentTurnStartIndex = selectedUserIndexes[selectedUserIndexes.length - 1] ?? userIndexes[userIndexes.length - 1] ?? 0;
    const context = [];
    for (let index = 0; index < selectedUserIndexes.length - 1; index += 1) {
        const userIndex = selectedUserIndexes[index] ?? 0;
        const nextUserIndex = selectedUserIndexes[index + 1] ?? sessionMessages.length;
        const userMessage = sessionMessages[userIndex];
        if (userMessage) {
            context.push(userMessage);
        }
        let finalAssistant;
        for (let inner = nextUserIndex - 1; inner > userIndex; inner -= 1) {
            const candidate = sessionMessages[inner];
            if (candidate?.role !== "assistant") {
                continue;
            }
            finalAssistant = stripAssistantToolCallNoise(candidate);
            if (finalAssistant) {
                break;
            }
        }
        if (finalAssistant) {
            context.push(finalAssistant);
        }
    }
    const currentTurnMessages = runMessages.length > 0 ? runMessages : sessionMessages.slice(currentTurnStartIndex);
    return [...context, ...currentTurnMessages];
}
function roleLabel(role) {
    switch (role) {
        case "tool":
            return "TOOL";
        case "toolResult":
            return "TOOL_RESULT";
        default:
            return role.toUpperCase();
    }
}
function renderTranscriptWindow(messages, maxMessages, maxChars) {
    const selected = messages.slice(-maxMessages);
    const rendered = selected
        .map((message) => `${roleLabel(message.role)}:\n${message.text.trim()}`)
        .filter(Boolean);
    const kept = [];
    let totalChars = 0;
    for (let index = rendered.length - 1; index >= 0; index -= 1) {
        const block = rendered[index];
        const candidateChars = totalChars + block.length + (kept.length > 0 ? 2 : 0);
        if (candidateChars > maxChars) {
            if (kept.length === 0) {
                kept.unshift(clipText(block, maxChars));
            }
            break;
        }
        kept.unshift(block);
        totalChars = candidateChars;
    }
    return kept.join("\n\n").trim();
}
export function buildValidatorPrompt(input) {
    const runTranscriptMessages = input.context?.runTranscriptMessages ?? [];
    const sessionTranscriptMessages = input.context?.sessionTranscriptMessages ?? [];
    const candidateTranscriptMessages = normalizeTranscriptMessages(input.candidate.messages);
    const transcriptSource = sessionTranscriptMessages.length > 0
        ? sessionTranscriptMessages
        : runTranscriptMessages.length > 0
            ? runTranscriptMessages
            : candidateTranscriptMessages;
    const transcriptWindow = input.config.includeCurrentTurnOnly
        ? sessionTranscriptMessages.length > 0
            ? buildRecentContextWithCurrentTurn(sessionTranscriptMessages, runTranscriptMessages, input.config.recentUserMessages)
            : runTranscriptMessages.length > 0
                ? runTranscriptMessages
                : buildCurrentTurnWindow(candidateTranscriptMessages, true)
        : transcriptSource;
    const transcript = renderTranscriptWindow(transcriptWindow, input.config.maxMessages, input.config.maxChars);
    return [
        "Decide whether the plugin should start a same-session follow-up run for this completed turn.",
        "",
        `Run ID: ${input.candidate.runId}`,
        `Conversation scope: ${input.config.includeCurrentTurnOnly
            ? `current work plus up to ${input.config.recentUserMessages} recent user turns`
            : "full available session history"}`,
        "",
        "Transcript:",
        transcript || "[No transcript text available]",
    ].join("\n");
}
function normalizeDecision(parsed, fallbackModel) {
    if (!parsed || typeof parsed !== "object") {
        throw new Error("validator returned a non-object response");
    }
    const value = parsed;
    if (typeof value.continue !== "boolean") {
        throw new Error("validator response is missing boolean continue");
    }
    const reason = normalizeString(value.reason);
    if (!reason) {
        throw new Error("validator response is missing reason");
    }
    const followUpInstruction = normalizeString(value.follow_up_instruction) ?? "";
    return {
        continue: value.continue,
        reason,
        followUpInstruction: followUpInstruction || undefined,
        validatorModel: fallbackModel,
    };
}
export async function validateContinuationWithLlm(input) {
    const apiKey = resolveLlmApiKey(input.config);
    if (!apiKey) {
        throw new Error(`missing OpenAI API key for validator; set ${input.config.apiKeyEnv ?? "an apiKey"}`);
    }
    input.logger?.step("preparing validator input", {
        runId: input.candidate.runId,
        sessionKey: input.candidate.sessionKey,
        model: input.config.model,
        includeCurrentTurnOnly: input.config.includeCurrentTurnOnly,
        recentUserMessages: input.config.recentUserMessages,
        candidateMessageCount: input.candidate.messages.length,
        runTranscriptMessageCount: input.context?.runTranscriptMessages?.length ?? 0,
        sessionTranscriptMessageCount: input.context?.sessionTranscriptMessages?.length ?? 0,
    });
    const response = await callResponsesJsonSchema({
        config: input.config,
        systemPrompt: input.config.systemPrompt,
        userPrompt: buildValidatorPrompt(input),
        schemaName: "keep_going_decision",
        schema: CONTINUATION_DECISION_SCHEMA,
        maxOutputTokens: OPENAI_VALIDATOR_INTERNAL_DEFAULTS.maxOutputTokens,
        logger: input.logger,
    }, apiKey);
    const refusal = response.refusal;
    if (refusal) {
        return {
            continue: false,
            reason: "validator-refused",
            validatorModel: input.config.model,
        };
    }
    const outputText = response.outputText;
    if (!outputText) {
        throw new Error("validator response did not include output text");
    }
    let parsed;
    try {
        parsed = JSON.parse(outputText);
    }
    catch (error) {
        throw new Error(`validator returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    const decision = normalizeDecision(parsed, input.config.model);
    input.logger?.step("validator JSON parsed", {
        runId: input.candidate.runId,
        sessionKey: input.candidate.sessionKey,
        continue: decision.continue,
        reason: decision.reason,
        hasFollowUpInstruction: Boolean(decision.followUpInstruction),
        validatorModel: decision.validatorModel,
    });
    return decision;
}
