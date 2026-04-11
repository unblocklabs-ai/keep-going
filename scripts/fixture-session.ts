import fs from "node:fs";
import path from "node:path";
import {
  buildSessionRouteFields,
  type SessionRouteEntry,
} from "../src/session-route.js";
import { resolveSampleDataRoot } from "./cli-shared.js";

export function loadMatchingFixtureSessionRoute(
  repoRoot: string,
  filePath: string,
  sessionId: string,
): {
  sessionKey?: string;
  route?: ReturnType<typeof buildSessionRouteFields>;
} {
  const storePath = path.join(resolveSampleDataRoot(repoRoot), "data", "sessions.json");
  if (!fs.existsSync(storePath)) {
    return {};
  }

  const basename = path.basename(filePath);
  const store = JSON.parse(fs.readFileSync(storePath, "utf8")) as Record<
    string,
    SessionRouteEntry & { sessionId?: string }
  >;
  const matched = Object.entries(store).find(([_, entry]) => {
    const storeBasename =
      typeof entry?.sessionFile === "string" ? path.basename(entry.sessionFile) : undefined;
    return entry?.sessionId === sessionId && storeBasename === basename;
  });

  if (!matched) {
    return {};
  }

  const [sessionKey, entry] = matched;
  return {
    sessionKey,
    route: buildSessionRouteFields(entry),
  };
}
