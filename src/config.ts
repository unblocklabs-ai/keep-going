import type { KeepGoingPluginConfig } from "./types.js";

const DEFAULT_CONFIG: KeepGoingPluginConfig = {
  enabled: true,
  channels: ["slack"],
  heuristic: {
    enabled: true,
  },
};

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const normalized = Math.floor(value);
  if (normalized < 1) {
    return undefined;
  }
  return normalized;
}

export function resolveKeepGoingConfig(raw: unknown): KeepGoingPluginConfig {
  const config = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const heuristic =
    config.heuristic && typeof config.heuristic === "object"
      ? (config.heuristic as Record<string, unknown>)
      : {};
  const channels = normalizeStringArray(config.channels);

  return {
    enabled: config.enabled !== false,
    channels: channels.length > 0 ? channels : DEFAULT_CONFIG.channels,
    timeoutMs: normalizePositiveInteger(config.timeoutMs),
    heuristic: {
      enabled: heuristic.enabled !== false,
    },
  };
}
