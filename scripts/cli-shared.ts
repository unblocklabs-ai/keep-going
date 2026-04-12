import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_OPENAI_VALIDATOR_CONFIG } from "../src/openai-validator-config.js";
import type { OpenAiLlmCallConfig } from "../src/types.js";
import type { JsonlEntry } from "./transcript-runs.js";

export type ParsedArgs = Record<string, string | boolean>;

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      continue;
    }
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
      continue;
    }
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

export function readStringArg(
  args: ParsedArgs,
  key: string,
): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function loadDotEnv(filePath: string): void {
  if (!fs.existsSync(filePath)) {
    return;
  }
  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator < 0) {
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (!key || process.env[key]) {
      continue;
    }
    process.env[key] = value;
  }
}

export function readJsonl(filePath: string): JsonlEntry[] {
  return fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as JsonlEntry);
}

export function findSessionId(entries: JsonlEntry[]): string {
  const sessionEntry = entries.find((entry) => entry.type === "session");
  if (sessionEntry?.id) {
    return sessionEntry.id;
  }
  throw new Error("session JSONL is missing top-level session id");
}

export function findWorkspaceDir(entries: JsonlEntry[]): string {
  const sessionEntry = entries.find((entry) => entry.type === "session");
  if (sessionEntry?.cwd) {
    return sessionEntry.cwd;
  }
  return process.cwd();
}

export function parsePositiveInteger(value: string | boolean | undefined): number | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return undefined;
  }
  return parsed;
}

export function parseConcurrency(
  value: string | boolean | undefined,
  fallback: number,
  max = 5,
): number {
  const parsed = parsePositiveInteger(value) ?? fallback;
  return Math.min(max, Math.max(1, parsed));
}

function resolveFirstEnvValue(names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

export function resolveOpenAiCliConfigOverrides(
  args: ParsedArgs,
  options: {
    modelEnvVars: string[];
    defaultTimeoutMs?: number;
  },
): Partial<OpenAiLlmCallConfig> {
  const model = readStringArg(args, "model") ?? resolveFirstEnvValue(options.modelEnvVars);
  const apiKey = readStringArg(args, "api-key");
  const timeoutMs = parsePositiveInteger(args["timeout-ms"]) ?? options.defaultTimeoutMs;

  return {
    ...(model ? { model } : {}),
    ...(apiKey ? { apiKey } : {}),
    apiKeyEnv: DEFAULT_OPENAI_VALIDATOR_CONFIG.apiKeyEnv,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
}

export function resolveSampleDataInputPath(repoRoot: string, providedFile: string): string {
  if (path.isAbsolute(providedFile)) {
    return providedFile;
  }

  const repoRelativePath = path.join(repoRoot, providedFile);
  if (fs.existsSync(repoRelativePath)) {
    return repoRelativePath;
  }

  return path.join(repoRoot, "sample_data", "data", providedFile);
}

export function resolveRequiredSampleDataInputPath(
  repoRoot: string,
  args: ParsedArgs,
): string {
  const providedFile = readStringArg(args, "file");
  if (!providedFile) {
    throw new Error("missing required --file argument");
  }
  return resolveSampleDataInputPath(repoRoot, providedFile);
}

export function resolveRepoRoot(moduleUrl: string): string {
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), "..");
}

export function resolveSampleDataRoot(repoRoot: string): string {
  return path.join(repoRoot, "sample_data");
}
