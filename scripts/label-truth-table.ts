import fs from "node:fs";
import path from "node:path";
import { normalizeTranscriptMessages, type TranscriptMessage } from "../src/messages.js";
import { createOpenAiValidatorConfig } from "../src/openai-validator-config.js";
import { labelTruthWithLlm } from "../src/truth-labeler.js";
import {
  extractLastAssistantRunSummary,
  messageObjects,
  splitIntoCompletedRuns,
} from "./transcript-runs.js";
import {
  findSessionId,
  loadDotEnv,
  parseArgs,
  parseConcurrency,
  parsePositiveInteger,
  readJsonl,
  resolveRepoRoot,
  resolveSampleDataInputPath,
  type ParsedArgs,
} from "./cli-shared.js";
import {
  mapWithConcurrency,
  resolvePreservedTruthTableOutputPath,
} from "./script-shared.js";
function buildLabelerConfig(args: ParsedArgs) {
  return createOpenAiValidatorConfig({
    model:
      (typeof args.model === "string" && args.model.trim()) ||
      process.env.KEEP_GOING_TRUTH_LABEL_MODEL ||
      process.env.KEEP_GOING_VALIDATOR_MODEL,
    apiKey: typeof args["api-key"] === "string" ? args["api-key"].trim() : undefined,
    apiKeyEnv:
      (typeof args["api-key-env"] === "string" && args["api-key-env"].trim()) ||
      process.env.KEEP_GOING_TRUTH_LABEL_API_KEY_ENV ||
      process.env.KEEP_GOING_VALIDATOR_API_KEY_ENV,
    maxMessages: Number.MAX_SAFE_INTEGER,
    maxChars: parsePositiveInteger(args["max-chars"]) ?? 200_000,
    includeCurrentTurnOnly: false,
    recentUserMessages: 3,
    temperature: 0,
    timeoutMs: parsePositiveInteger(args["timeout-ms"]) ?? 30_000,
  });
}

function resolveInputPath(repoRoot: string, providedFile: string): string {
  return resolveSampleDataInputPath(repoRoot, providedFile);
}

function resolveOutputPath(filePath: string, override: string | boolean | undefined): string {
  if (typeof override === "string" && override.trim()) {
    return path.resolve(override.trim());
  }
  return resolvePreservedTruthTableOutputPath(filePath);
}

function renderTranscript(messages: TranscriptMessage[], maxChars: number): string {
  const rendered = messages
    .map((message) => `${message.role.toUpperCase()}:\n${message.text.trim()}`)
    .filter(Boolean)
    .join("\n\n")
    .trim();

  if (rendered.length <= maxChars) {
    return rendered;
  }
  return `${rendered.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function buildTruthPrompt(params: {
  sessionId: string;
  runIndex: number;
  runId: string;
  assistantMessageId?: string;
  assistantMessage?: string;
  transcript: TranscriptMessage[];
  maxChars: number;
}): string {
  return [
    "Label whether this assistant turn should have continued automatically.",
    "",
    `Session ID: ${params.sessionId}`,
    `Run Index: ${params.runIndex}`,
    `Run ID: ${params.runId}`,
    `Assistant Message ID: ${params.assistantMessageId ?? "unknown"}`,
    "",
    "Assistant final reply:",
    params.assistantMessage ?? "[No assistant reply found]",
    "",
    "Full transcript so far:",
    renderTranscript(params.transcript, params.maxChars),
  ].join("\n");
}

async function main(): Promise<void> {
  const repoRoot = resolveRepoRoot(import.meta.url);
  loadDotEnv(path.join(repoRoot, ".env"));

  const args = parseArgs(process.argv.slice(2));
  const providedFile = typeof args.file === "string" ? args.file : undefined;
  if (!providedFile) {
    throw new Error("missing required --file argument");
  }

  const filePath = resolveInputPath(repoRoot, providedFile);
  const entries = readJsonl(filePath);
  const sessionId = findSessionId(entries);
  const completedRuns = splitIntoCompletedRuns(entries);
  const config = buildLabelerConfig(args);
  const concurrency = parseConcurrency(args.concurrency, 3);

  const cumulativeMessages: unknown[] = [];
  const prepared = completedRuns.map((run) => {
    const runMessages = messageObjects(run.entries);
    cumulativeMessages.push(...runMessages);
    const normalizedSessionMessages = normalizeTranscriptMessages(cumulativeMessages);
    const assistantSummary = extractLastAssistantRunSummary(run.entries);
    return {
      run,
      normalizedSessionMessages,
      assistantSummary,
      prompt: buildTruthPrompt({
        sessionId,
        runIndex: run.runIndex,
        runId: run.runId,
        assistantMessageId: assistantSummary?.messageId,
        assistantMessage: assistantSummary?.text,
        transcript: normalizedSessionMessages,
        maxChars: config.maxChars,
      }),
    };
  });

  const labels = await mapWithConcurrency(prepared, concurrency, async (item) => {
    const startedAt = Date.now();
    try {
      const truth = await labelTruthWithLlm({
        config,
        prompt: item.prompt,
      });
      return {
        sessionId,
        runIndex: item.run.runIndex,
        runId: item.run.runId,
        completedAt: item.run.completedAt ?? null,
        assistantMessageId: item.assistantSummary?.messageId ?? null,
        assistantMessageTimestamp: item.assistantSummary?.timestamp ?? null,
        assistantMessage: item.assistantSummary?.text ?? null,
        continueFact: truth.continueFact,
        notes: truth.notes || truth.reason,
        labelReason: truth.reason,
        labelModel: truth.labelModel,
        latencyMs: Date.now() - startedAt,
        error: null,
      };
    } catch (error) {
      return {
        sessionId,
        runIndex: item.run.runIndex,
        runId: item.run.runId,
        completedAt: item.run.completedAt ?? null,
        assistantMessageId: item.assistantSummary?.messageId ?? null,
        assistantMessageTimestamp: item.assistantSummary?.timestamp ?? null,
        assistantMessage: item.assistantSummary?.text ?? null,
        continueFact: null,
        notes: "",
        labelReason: "",
        labelModel: config.model,
        latencyMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  const failedLabelCount = labels.filter((label) => typeof label.error === "string").length;

  const output = {
    sourceFile: filePath,
    generatedAt: new Date().toISOString(),
    sessionId,
    labelerConfig: {
      provider: config.provider,
      model: config.model,
      maxChars: config.maxChars,
      timeoutMs: config.timeoutMs ?? 30_000,
      concurrency,
    },
    completedRunCount: completedRuns.length,
    failedLabelCount,
    labels,
  };

  const outputPath = resolveOutputPath(filePath, args.out);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(outputPath);
}

await main();
