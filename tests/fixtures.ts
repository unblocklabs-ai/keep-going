import fs from "node:fs";
import path from "node:path";

const SAMPLE_DATA_DIR = path.resolve(import.meta.dirname, "..", "sample_data");
const SAMPLE_DATA_INPUT_DIR = path.join(SAMPLE_DATA_DIR, "data");

export type SessionStore = Record<string, unknown>;

export function readSampleJsonl(fileName: string): unknown[] {
  const filePath = path.join(SAMPLE_DATA_INPUT_DIR, fileName);
  const raw = fs.readFileSync(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function readSampleTranscriptMessages(fileName: string): unknown[] {
  return readSampleJsonl(fileName)
    .filter((entry): entry is { type: string; message: unknown } => {
      return Boolean(
        entry &&
          typeof entry === "object" &&
          (entry as { type?: unknown }).type === "message" &&
          "message" in (entry as Record<string, unknown>),
      );
    })
    .map((entry) => entry.message);
}

export function readSampleSessionStore(): SessionStore {
  const filePath = path.join(SAMPLE_DATA_INPUT_DIR, "sessions.json");
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as SessionStore;
}
