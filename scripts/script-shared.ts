import fs from "node:fs";
import path from "node:path";
import type { ParsedArgs } from "./cli-shared.js";

const SAMPLE_DATA_ROOT_NAME = "sample_data";
const SAMPLE_DATA_INPUT_DIR_NAME = "data";
const SAMPLE_DATA_VAL_DIR_NAME = "val";
const SAMPLE_DATA_LLM_REVIEW_DIR_NAME = "llm-review";
const SAMPLE_DATA_CLEANED_DIR_NAME = "cleaned";
const SAMPLE_DATA_STATE_DIR_NAME = "state";

export function mapWithConcurrency<TInput, TOutput>(
  values: TInput[],
  concurrency: number,
  mapper: (value: TInput, index: number) => Promise<TOutput>,
): Promise<TOutput[]> {
  const results = Array.from({ length: values.length }) as TOutput[];
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= values.length) {
        return;
      }
      results[currentIndex] = await mapper(values[currentIndex] as TInput, currentIndex);
    }
  }

  const workerCount = Math.min(concurrency, values.length);
  return Promise.all(Array.from({ length: workerCount }, () => worker())).then(() => results);
}

export function buildTimestampSuffix(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export function resolveOptionalOutputPath(
  args: ParsedArgs,
  fallback: (filePath: string) => string,
  filePath: string,
): string {
  const override = args.out;
  if (typeof override === "string" && override.trim()) {
    return path.resolve(override.trim());
  }
  return fallback(filePath);
}

function resolveSampleDataOutputDir(
  filePath: string,
  targetDirName: string,
): string {
  const inputDir = path.dirname(filePath);
  const sampleDataDir = path.dirname(inputDir);
  if (
    path.basename(inputDir) === SAMPLE_DATA_INPUT_DIR_NAME &&
    path.basename(sampleDataDir) === SAMPLE_DATA_ROOT_NAME
  ) {
    return path.join(sampleDataDir, targetDirName);
  }
  return inputDir;
}

export function resolveCanonicalTruthTablePath(filePath: string): string {
  const dirname = resolveSampleDataOutputDir(filePath, SAMPLE_DATA_VAL_DIR_NAME);
  const basename = path.basename(filePath, ".jsonl");
  return path.join(dirname, `${basename}.truth-table.json`);
}

export function resolvePreservedTruthTableOutputPath(filePath: string): string {
  const standard = resolveCanonicalTruthTablePath(filePath);
  if (!fs.existsSync(standard)) {
    return standard;
  }

  const dirname = resolveSampleDataOutputDir(filePath, SAMPLE_DATA_VAL_DIR_NAME);
  const basename = path.basename(filePath, ".jsonl");
  return path.join(
    dirname,
    `${basename}.truth-table.${buildTimestampSuffix()}.json`,
  );
}

export function resolveLatestTruthTablePath(filePath: string): string {
  const standard = resolveCanonicalTruthTablePath(filePath);
  const dirname = resolveSampleDataOutputDir(filePath, SAMPLE_DATA_VAL_DIR_NAME);
  const basename = path.basename(filePath, ".jsonl");
  const prefix = `${basename}.truth-table`;

  if (!fs.existsSync(dirname)) {
    return standard;
  }

  const candidates = fs
    .readdirSync(dirname)
    .filter((name) => {
      if (!name.endsWith(".json")) {
        return false;
      }
      if (name === `${prefix}.json`) {
        return true;
      }
      return name.startsWith(`${prefix}.`);
    })
    .map((name) => {
      const absolutePath = path.join(dirname, name);
      return {
        path: absolutePath,
        mtimeMs: fs.statSync(absolutePath).mtimeMs,
      };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs);

  return candidates[0]?.path ?? standard;
}

export function resolveLlmReviewOutputPath(filePath: string): string {
  const dirname = resolveSampleDataOutputDir(filePath, SAMPLE_DATA_LLM_REVIEW_DIR_NAME);
  const basename = path.basename(filePath, ".jsonl");
  return path.join(dirname, `${basename}.llm-review.${buildTimestampSuffix()}.json`);
}

export function resolveCleanedOutputPath(filePath: string): string {
  const dirname = resolveSampleDataOutputDir(filePath, SAMPLE_DATA_CLEANED_DIR_NAME);
  const basename = path.basename(filePath, ".jsonl");
  return path.join(dirname, `${basename}.cleaned.json`);
}

export function resolveStateOutputPath(filePath: string): string {
  const dirname = resolveSampleDataOutputDir(filePath, SAMPLE_DATA_STATE_DIR_NAME);
  const basename = path.basename(filePath, ".jsonl");
  return path.join(dirname, `${basename}.state.json`);
}
