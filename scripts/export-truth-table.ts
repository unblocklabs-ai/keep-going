import fs from "node:fs";
import path from "node:path";
import { extractLastAssistantRunSummary, splitIntoCompletedRuns } from "./transcript-runs.js";
import {
  findSessionId,
  parseArgs,
  readJsonl,
  resolveRepoRoot,
  resolveSampleDataInputPath,
} from "./cli-shared.js";
import { resolveCanonicalTruthTablePath } from "./script-shared.js";

function resolveInputPath(repoRoot: string, providedFile: string): string {
  return resolveSampleDataInputPath(repoRoot, providedFile);
}

function resolveOutputPath(filePath: string, override: string | boolean | undefined): string {
  if (typeof override === "string" && override.trim()) {
    return path.resolve(override.trim());
  }
  return resolveCanonicalTruthTablePath(filePath);
}

async function main(): Promise<void> {
  const repoRoot = resolveRepoRoot(import.meta.url);
  const args = parseArgs(process.argv.slice(2));
  const providedFile = typeof args.file === "string" ? args.file : undefined;
  if (!providedFile) {
    throw new Error("missing required --file argument");
  }

  const filePath = resolveInputPath(repoRoot, providedFile);
  const entries = readJsonl(filePath);
  const sessionId = findSessionId(entries);
  const completedRuns = splitIntoCompletedRuns(entries);

  const labels = completedRuns.map((run) => {
    const assistantSummary = extractLastAssistantRunSummary(run.entries);
    return {
      sessionId,
      runIndex: run.runIndex,
      runId: run.runId,
      completedAt: run.completedAt ?? null,
      assistantMessageId: assistantSummary?.messageId ?? null,
      assistantMessageTimestamp: assistantSummary?.timestamp ?? null,
      assistantMessage: assistantSummary?.text ?? null,
      continueFact: null,
      notes: "",
    };
  });

  const output = {
    sourceFile: filePath,
    generatedAt: new Date().toISOString(),
    sessionId,
    completedRunCount: completedRuns.length,
    labels,
  };

  const outputPath = resolveOutputPath(filePath, args.out);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(outputPath);
}

await main();
