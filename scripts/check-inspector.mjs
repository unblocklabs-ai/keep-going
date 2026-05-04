#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const HOME = process.env.HOME ?? "";
const INSPECTOR_BIN = path.join(ROOT, "node_modules", ".bin", "plugin-inspector");
const allowNoOpenClaw = process.env.CHECK_INSPECTOR_ALLOW_NO_OPENCLAW === "1";
const CANDIDATE_OPENCLAW_CHECKOUTS = [
  process.env.OPENCLAW_CHECKOUT,
  path.join(HOME, "Desktop", "openclaw"),
  path.join(HOME, "tmp-openclaw-audit", "openclaw"),
  path.join(HOME, "tmp-openclaw", "openclaw")
].filter(Boolean);

function findOpenClawCheckout() {
  for (const candidate of CANDIDATE_OPENCLAW_CHECKOUTS) {
    const packageJsonPath = path.join(candidate, "package.json");
    if (!fs.existsSync(packageJsonPath)) {
      continue;
    }
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    if (packageJson.name === "openclaw") {
      return candidate;
    }
  }
  return undefined;
}

const openclawCheckout = findOpenClawCheckout();
if (!openclawCheckout && !allowNoOpenClaw) {
  console.error(
    "No local OpenClaw checkout found. Set OPENCLAW_CHECKOUT=/path/to/openclaw or CHECK_INSPECTOR_ALLOW_NO_OPENCLAW=1.",
  );
  process.exit(1);
}

const args = [
  "check",
  "--plugin-root",
  ROOT,
  "--config",
  path.join(ROOT, "plugin-inspector.config.json"),
  "--out",
  "/tmp/keep-going-plugin-inspector",
  "--json"
];

if (openclawCheckout) {
  args.push("--openclaw", openclawCheckout);
} else {
  args.push("--no-openclaw");
}

const child = spawn(INSPECTOR_BIN, args, {
  cwd: ROOT,
  stdio: "inherit"
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
