import path from "node:path";
import { buildValidatorPrompt, validateContinuationWithLlm } from "../src/llm-validator.js";
import { normalizeTranscriptMessages } from "../src/messages.js";
import { createDefaultOpenAiValidatorConfig } from "../src/openai-validator-config.js";
import { messageObjects, splitIntoCompletedRuns } from "./transcript-runs.js";
import type { ContinuationCandidate } from "../src/types.js";
import {
  findSessionId,
  loadDotEnv,
  parseArgs,
  resolveOpenAiCliConfigOverrides,
  resolveSampleDataInputPath,
  resolveRepoRoot,
  readJsonl,
} from "./cli-shared.js";

const DEFAULT_FILE =
  "42c136e7-6ba6-42e3-afd1-485aa6a99832-topic-1775879458.009949.jsonl";
const DEFAULT_WORKSPACE_DIR = "/Users/billjohansson/clawd";

function parseRunSelection(
  value: string | boolean | undefined,
  runCount: number,
): number {
  if (value === undefined || value === true || value === "latest") {
    return runCount - 1;
  }
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed >= runCount) {
    throw new Error(`invalid --run value "${String(value)}"; expected 0..${runCount - 1} or latest`);
  }
  return parsed;
}

function renderPreview(value: string, maxChars = 1200): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

async function main(): Promise<void> {
  const repoRoot = resolveRepoRoot(import.meta.url);
  loadDotEnv(path.join(repoRoot, ".env"));

  const args = parseArgs(process.argv.slice(2));
  const sampleFile = String(args.file ?? DEFAULT_FILE);
  const filePath = resolveSampleDataInputPath(repoRoot, sampleFile);

  const entries = readJsonl(filePath);
  const segments = splitIntoCompletedRuns(entries);
  const selectedRunIndex = parseRunSelection(args.run, segments.length);
  const runEntries = segments[selectedRunIndex]?.entries ?? [];
  const runMessages = messageObjects(runEntries);
  const normalizedRunMessages = normalizeTranscriptMessages(runMessages);

  if (runMessages.length === 0) {
    throw new Error(`selected run ${selectedRunIndex} contains no message objects`);
  }

  const firstSessionEntry = entries.find((entry) => entry.type === "session");
  const sessionId = firstSessionEntry ? findSessionId(entries) : "fixture-session";
  const validatorOverrides = resolveOpenAiCliConfigOverrides(args, {
    modelEnvVars: ["KEEP_GOING_VALIDATOR_MODEL"],
  });
  const model = validatorOverrides.model;

  const candidate: ContinuationCandidate = {
    runId: `fixture-run-${selectedRunIndex}`,
    agentId: "main",
    sessionId,
    sessionKey: `fixture:${path.basename(filePath)}`,
    workspaceDir: DEFAULT_WORKSPACE_DIR,
    modelProviderId: "openai",
    modelId: model || "gpt-5.4-mini",
    trigger: "message",
    success: true,
    messages: runMessages,
  };

  const config = createDefaultOpenAiValidatorConfig(validatorOverrides);
  const sessionMessages = segments
    .slice(0, selectedRunIndex + 1)
    .flatMap((segment) => messageObjects(segment.entries));
  const normalizedSessionMessages = normalizeTranscriptMessages(sessionMessages);

  const prompt = buildValidatorPrompt({
    candidate,
    config,
    context: {
      runTranscriptMessages: normalizedRunMessages,
      sessionTranscriptMessages: normalizedSessionMessages,
    },
  });

  const decision = await validateContinuationWithLlm({
    candidate,
    config,
    context: {
      runTranscriptMessages: normalizedRunMessages,
      sessionTranscriptMessages: normalizedSessionMessages,
    },
  });

  console.log(
    JSON.stringify(
      {
        file: filePath,
        selectedRunIndex,
        runCount: segments.length,
        validatorModel: decision.validatorModel,
        continue: decision.continue,
        reason: decision.reason,
        followUpInstruction: decision.followUpInstruction ?? "",
        transcriptMessageCount: normalizedRunMessages.length,
        sessionTranscriptMessageCount: normalizedSessionMessages.length,
      },
      null,
      2,
    ),
  );

  if (args["print-prompt"]) {
    console.log("\n--- validator prompt preview ---\n");
    console.log(renderPreview(prompt));
  }
}

await main();
