import fs from "node:fs";
import path from "node:path";
import { validateContinuationWithLlm } from "../src/llm-validator.js";
import { normalizeTranscriptMessages } from "../src/messages.js";
import { normalizeString } from "../src/normalize.js";
import { createOpenAiValidatorConfig } from "../src/openai-validator-config.js";
import {
  extractLastAssistantRunSummary,
  messageObjects,
  splitIntoCompletedRuns,
} from "./transcript-runs.js";
import {
  findSessionId,
  findWorkspaceDir,
  loadDotEnv,
  parseArgs,
  parseConcurrency,
  parsePositiveInteger,
  readJsonl,
  resolveRepoRoot,
  resolveSampleDataInputPath,
  type ParsedArgs,
} from "./cli-shared.js";
import { loadMatchingFixtureSessionRoute } from "./fixture-session.js";
import {
  mapWithConcurrency,
  resolveLlmReviewOutputPath,
  resolveLatestTruthTablePath,
} from "./script-shared.js";
import type { ContinuationCandidate } from "../src/types.js";
type TruthTableLabel = {
  sessionId?: string;
  runIndex?: number;
  runId?: string;
  assistantMessageId?: string | null;
  continueFact?: boolean | null;
  notes?: string;
};

type TruthTableFile = {
  sessionId?: string;
  labels?: TruthTableLabel[];
};

type PreparedRun = {
  runIndex: number;
  runId: string;
  completedAt?: string;
  runMessages: unknown[];
  normalizedRunMessages: ReturnType<typeof normalizeTranscriptMessages>;
  normalizedSessionMessages: ReturnType<typeof normalizeTranscriptMessages>;
  assistantSummary?: ReturnType<typeof extractLastAssistantRunSummary>;
  candidate: ContinuationCandidate;
  truth?: TruthTableLabel;
};

function buildValidatorConfig(args: ParsedArgs) {
  return createOpenAiValidatorConfig({
    model:
      (typeof args.model === "string" && args.model.trim()) ||
      process.env.KEEP_GOING_VALIDATOR_MODEL,
    apiKey: typeof args["api-key"] === "string" ? args["api-key"].trim() : undefined,
    apiKeyEnv:
      (typeof args["api-key-env"] === "string" && args["api-key-env"].trim()) ||
      process.env.KEEP_GOING_VALIDATOR_API_KEY_ENV,
    maxMessages: 20,
    maxChars: 20_000,
    includeCurrentTurnOnly: true,
    recentUserMessages: 3,
    temperature: 0,
    timeoutMs: parsePositiveInteger(args["timeout-ms"]) ?? 15_000,
  });
}

function parseRunFilter(value: string | boolean | undefined, runCount: number): number[] {
  if (runCount === 0) {
    return [];
  }
  if (value === undefined || value === true || value === "all") {
    return Array.from({ length: runCount }, (_, index) => index);
  }
  if (value === "latest") {
    return [runCount - 1];
  }
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed >= runCount) {
    throw new Error(`invalid --run value "${String(value)}"; expected all, latest, or 0..${runCount - 1}`);
  }
  return [parsed];
}

function resolveOutputPath(filePath: string, override: string | boolean | undefined): string {
  if (typeof override === "string" && override.trim()) {
    return path.resolve(override.trim());
  }
  return resolveLlmReviewOutputPath(filePath);
}

function resolveTruthTablePath(filePath: string, override: string | boolean | undefined): string {
  if (typeof override === "string" && override.trim()) {
    return path.resolve(override.trim());
  }
  return resolveLatestTruthTablePath(filePath);
}

function loadTruthTable(
  filePath: string,
  override: string | boolean | undefined,
): { path: string; labelsByKey: Map<string, TruthTableLabel> } | undefined {
  const truthTablePath = resolveTruthTablePath(filePath, override);
  if (!fs.existsSync(truthTablePath)) {
    return undefined;
  }

  const truthTable = JSON.parse(fs.readFileSync(truthTablePath, "utf8")) as TruthTableFile;
  const labelsByKey = new Map<string, TruthTableLabel>();
  for (const label of truthTable.labels ?? []) {
    const assistantMessageId = normalizeString(label.assistantMessageId);
    if (assistantMessageId) {
      labelsByKey.set(`assistant:${assistantMessageId}`, label);
      continue;
    }
    if (typeof label.runIndex === "number") {
      labelsByKey.set(`runIndex:${label.runIndex}`, label);
    }
  }

  return {
    path: truthTablePath,
    labelsByKey,
  };
}

function resolveTruthLabel(
  truthTable: { labelsByKey: Map<string, TruthTableLabel> } | undefined,
  params: {
    runIndex: number;
    assistantMessageId?: string;
  },
): TruthTableLabel | undefined {
  if (!truthTable) {
    return undefined;
  }
  if (params.assistantMessageId) {
    const byMessageId = truthTable.labelsByKey.get(`assistant:${params.assistantMessageId}`);
    if (byMessageId) {
      return byMessageId;
    }
  }
  return truthTable.labelsByKey.get(`runIndex:${params.runIndex}`);
}

function summarizeEvaluation(
  reviews: Array<Record<string, unknown>>,
): {
  comparedRunCount: number;
  matchedRunCount: number;
  accuracy: number | null;
  truePositive: number;
  trueNegative: number;
  falsePositive: number;
  falseNegative: number;
  mismatches: Array<{
    runIndex: number;
    assistantMessageId?: string | null;
    expectedContinue: boolean;
    actualContinue: boolean;
  }>;
} {
  let comparedRunCount = 0;
  let matchedRunCount = 0;
  let truePositive = 0;
  let trueNegative = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  const mismatches: Array<{
    runIndex: number;
    assistantMessageId?: string | null;
    expectedContinue: boolean;
    actualContinue: boolean;
  }> = [];

  for (const review of reviews) {
    const truth = review.truth as { continueFact?: boolean | null } | undefined;
    const validatorOutput = review.validatorOutput as { continue?: boolean } | undefined;
    const runIndex = typeof review.runIndex === "number" ? review.runIndex : undefined;
    const assistantMessageId =
      typeof review.assistantMessageId === "string" ? review.assistantMessageId : null;
    if (typeof truth?.continueFact !== "boolean" || typeof validatorOutput?.continue !== "boolean") {
      continue;
    }

    comparedRunCount += 1;
    if (truth.continueFact === validatorOutput.continue) {
      matchedRunCount += 1;
      if (truth.continueFact) {
        truePositive += 1;
      } else {
        trueNegative += 1;
      }
      continue;
    }

    if (truth.continueFact) {
      falseNegative += 1;
    } else {
      falsePositive += 1;
    }

    mismatches.push({
      runIndex: runIndex ?? -1,
      assistantMessageId,
      expectedContinue: truth.continueFact,
      actualContinue: validatorOutput.continue,
    });
  }

  return {
    comparedRunCount,
    matchedRunCount,
    accuracy: comparedRunCount > 0 ? matchedRunCount / comparedRunCount : null,
    truePositive,
    trueNegative,
    falsePositive,
    falseNegative,
    mismatches,
  };
}

async function main(): Promise<void> {
  const repoRoot = resolveRepoRoot(import.meta.url);
  loadDotEnv(path.join(repoRoot, ".env"));

  const args = parseArgs(process.argv.slice(2));
  const providedFile = typeof args.file === "string" ? args.file : undefined;
  if (!providedFile) {
    throw new Error("missing required --file argument");
  }

  const filePath = resolveSampleDataInputPath(repoRoot, providedFile);
  const entries = readJsonl(filePath);
  const sessionId = findSessionId(entries);
  const workspaceDir = findWorkspaceDir(entries);
  const completedRuns = splitIntoCompletedRuns(entries);
  const selectedRunIndexes = parseRunFilter(args.run, completedRuns.length);
  const config = buildValidatorConfig(args);
  const concurrency = parseConcurrency(args.concurrency, 5);
  const routeMatch = loadMatchingFixtureSessionRoute(repoRoot, filePath, sessionId);
  const truthTable = loadTruthTable(filePath, args["truth-table"]);
  const normalizedSessionMessagesByRunIndex = new Map<number, ReturnType<typeof normalizeTranscriptMessages>>();

  const cumulativeSessionMessages: unknown[] = [];
  for (const run of completedRuns) {
    const runMessages = messageObjects(run.entries);
    cumulativeSessionMessages.push(...runMessages);
    normalizedSessionMessagesByRunIndex.set(
      run.runIndex,
      normalizeTranscriptMessages(cumulativeSessionMessages),
    );
  }

  const preparedRuns: PreparedRun[] = [];
  for (const runIndex of selectedRunIndexes) {
    const run = completedRuns[runIndex];
    if (!run) {
      continue;
    }

    const runMessages = messageObjects(run.entries);
    const normalizedRunMessages = normalizeTranscriptMessages(runMessages);
    const normalizedSessionMessages =
      normalizedSessionMessagesByRunIndex.get(run.runIndex) ?? normalizedRunMessages;
    const assistantSummary = extractLastAssistantRunSummary(run.entries);
    const candidate: ContinuationCandidate = {
      runId: run.runId,
      agentId: "main",
      sessionId,
      sessionKey: routeMatch.sessionKey ?? `fixture:${path.basename(filePath)}`,
      workspaceDir,
      modelProviderId: routeMatch.route?.modelProviderId ?? "openai-codex",
      modelId: routeMatch.route?.modelId ?? "gpt-5.4",
      trigger: "message",
      success: true,
      messages: runMessages,
    };

    preparedRuns.push({
      runIndex: run.runIndex,
      runId: run.runId,
      completedAt: run.completedAt,
      runMessages,
      normalizedRunMessages,
      normalizedSessionMessages,
      assistantSummary,
      candidate,
      truth: resolveTruthLabel(truthTable, {
        runIndex: run.runIndex,
        assistantMessageId: assistantSummary?.messageId,
      }),
    });
  }

  const reviews = await mapWithConcurrency(preparedRuns, concurrency, async (prepared) => {
    const startedAt = Date.now();
    try {
      const validatorOutput = await validateContinuationWithLlm({
        candidate: prepared.candidate,
        config,
        context: {
          runTranscriptMessages: prepared.normalizedRunMessages,
          sessionTranscriptMessages: prepared.normalizedSessionMessages,
        },
      });

      return {
        runIndex: prepared.runIndex,
        runId: prepared.runId,
        completedAt: prepared.completedAt,
        assistantMessageId: prepared.assistantSummary?.messageId ?? null,
        assistantMessageTimestamp: prepared.assistantSummary?.timestamp ?? null,
        assistantMessage: prepared.assistantSummary?.text ?? null,
        metadata: {
          messageCount: prepared.runMessages.length,
          transcriptMessageCount: prepared.normalizedRunMessages.length,
          sessionTranscriptMessageCount: prepared.normalizedSessionMessages.length,
          latencyMs: Date.now() - startedAt,
        },
        ...(prepared.truth
          ? {
              truth: {
                continueFact:
                  typeof prepared.truth.continueFact === "boolean"
                    ? prepared.truth.continueFact
                    : null,
                notes: prepared.truth.notes ?? "",
              },
            }
          : {}),
        validatorOutput: {
          continue: validatorOutput.continue,
          reason: validatorOutput.reason,
          followUpInstruction: validatorOutput.followUpInstruction ?? "",
          validatorModel: validatorOutput.validatorModel,
        },
      };
    } catch (error) {
      return {
        runIndex: prepared.runIndex,
        runId: prepared.runId,
        completedAt: prepared.completedAt,
        assistantMessageId: prepared.assistantSummary?.messageId ?? null,
        assistantMessageTimestamp: prepared.assistantSummary?.timestamp ?? null,
        assistantMessage: prepared.assistantSummary?.text ?? null,
        metadata: {
          messageCount: prepared.runMessages.length,
          transcriptMessageCount: prepared.normalizedRunMessages.length,
          sessionTranscriptMessageCount: prepared.normalizedSessionMessages.length,
          latencyMs: Date.now() - startedAt,
        },
        ...(prepared.truth
          ? {
              truth: {
                continueFact:
                  typeof prepared.truth.continueFact === "boolean"
                    ? prepared.truth.continueFact
                    : null,
                notes: prepared.truth.notes ?? "",
              },
            }
          : {}),
        validatorError: error instanceof Error ? error.message : String(error),
      };
    }
  });
  reviews.sort((left, right) => left.runIndex - right.runIndex);
  const evaluation = summarizeEvaluation(reviews);

  const outputPath = resolveOutputPath(filePath, args.out);
  const output = {
    sourceFile: filePath,
    generatedAt: new Date().toISOString(),
    sessionId,
    sessionKey: routeMatch.sessionKey ?? null,
    route: routeMatch.route ?? null,
    validatorConfig: {
      provider: config.provider,
      model: config.model,
      maxMessages: config.maxMessages,
      maxChars: config.maxChars,
      includeCurrentTurnOnly: config.includeCurrentTurnOnly,
      recentUserMessages: config.recentUserMessages,
      temperature: config.temperature ?? 0,
      timeoutMs: config.timeoutMs ?? 15_000,
      concurrency,
    },
    truthTablePath: truthTable?.path ?? null,
    evaluation,
    completedRunCount: completedRuns.length,
    reviewedRunIndexes: selectedRunIndexes,
    runs: reviews,
  };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(outputPath);
}

await main();
