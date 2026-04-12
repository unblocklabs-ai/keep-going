import fs from "node:fs";
import path from "node:path";
import {
  extractInitialSlackThreadHistoryMessages,
  extractLastAssistantHumanFacingText,
  extractLastUserHumanFacingText,
} from "../src/messages.js";
import {
  findSessionId,
  loadDotEnv,
  parseArgs,
  readJsonl,
  resolveRequiredSampleDataInputPath,
  resolveRepoRoot,
} from "./cli-shared.js";
import { resolveCleanedOutputPath, resolveOptionalOutputPath } from "./script-shared.js";
import { messageObjects, splitIntoCompletedRuns } from "./transcript-runs.js";

type CleanedTurnMessage = {
  type: "user" | "assistant";
  msg: string;
};

function mergeAdjacentAssistantMessages(
  messages: CleanedTurnMessage[],
): CleanedTurnMessage[] {
  const merged: CleanedTurnMessage[] = [];

  for (const message of messages) {
    const previous = merged.at(-1);
    if (message.type === "assistant" && previous?.type === "assistant") {
      previous.msg = `${previous.msg}\n\n${message.msg}`.trim();
      continue;
    }
    merged.push({ ...message });
  }

  return merged;
}

async function main(): Promise<void> {
  const repoRoot = resolveRepoRoot(import.meta.url);
  loadDotEnv(path.join(repoRoot, ".env"));

  const args = parseArgs(process.argv.slice(2));
  const filePath = resolveRequiredSampleDataInputPath(repoRoot, args);
  const entries = readJsonl(filePath);
  const sessionId = findSessionId(entries);
  const completedRuns = splitIntoCompletedRuns(entries);
  const initialHistoryMessages =
    completedRuns[0] ? extractInitialSlackThreadHistoryMessages(messageObjects(completedRuns[0].entries)) : [];
  const msgs = completedRuns
    .map((run) => {
      const messages = messageObjects(run.entries);
      return [
        (() => {
          const userText = extractLastUserHumanFacingText(messages);
          return userText ? ({ type: "user", msg: userText } satisfies CleanedTurnMessage) : undefined;
        })(),
        (() => {
          const assistantText = extractLastAssistantHumanFacingText(messages);
          return assistantText
            ? ({ type: "assistant", msg: assistantText } satisfies CleanedTurnMessage)
            : undefined;
        })(),
      ];
    })
    .flat()
    .filter((value): value is CleanedTurnMessage => Boolean(value));

  const output = {
    session_id: sessionId,
    source_file: filePath,
    visible_turns: completedRuns.length,
    msgs: mergeAdjacentAssistantMessages([...initialHistoryMessages, ...msgs]),
  };

  const outputPath = resolveOptionalOutputPath(args, resolveCleanedOutputPath, filePath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(outputPath);
}

await main();
