import fs from "node:fs";
import path from "node:path";
import { extractLastAssistantRunSummary, splitIntoCompletedRuns } from "./transcript-runs.js";
import {
  parseArgs,
  findSessionId,
  readJsonl,
  resolveRequiredSampleDataInputPath,
  resolveRepoRoot,
} from "./cli-shared.js";
import { resolveCanonicalTruthTablePath, resolveOptionalOutputPath } from "./script-shared.js";

async function main(): Promise<void> {
  const repoRoot = resolveRepoRoot(import.meta.url);
  const args = parseArgs(process.argv.slice(2));
  const filePath = resolveRequiredSampleDataInputPath(repoRoot, args);
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

  const outputPath = resolveOptionalOutputPath(args, resolveCanonicalTruthTablePath, filePath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(outputPath);
}

await main();
