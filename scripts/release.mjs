#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const PACKAGE_JSON_PATH = path.join(ROOT, "package.json");
const PACKAGE_LOCK_PATH = path.join(ROOT, "package-lock.json");
const OPENCLAW_PLUGIN_PATH = path.join(ROOT, "openclaw.plugin.json");
const MARKETPLACE_PATH = path.join(ROOT, ".claude-plugin", "marketplace.json");
const RELEASED_BRANCH = "main";
const RELEASE_STAGE_PATHS = [
  "package.json",
  "package-lock.json",
  "openclaw.plugin.json",
  ".claude-plugin/marketplace.json",
  "dist",
];

function fail(message) {
  console.error(message);
  process.exit(1);
}

function run(cmd, args, options = {}) {
  const rendered = [cmd, ...args].join(" ");
  if (options.dryRun) {
    console.log(`[dry-run] ${rendered}`);
    return "";
  }
  return execFileSync(cmd, args, {
    cwd: ROOT,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
  })?.trim() ?? "";
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function parseArgs(argv) {
  const result = {
    bump: undefined,
    dryRun: false,
    message: undefined,
    skipChecks: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) {
      continue;
    }
    if (arg === "--dry-run") {
      result.dryRun = true;
      continue;
    }
    if (arg === "--skip-checks") {
      result.skipChecks = true;
      continue;
    }
    if (arg === "--message" || arg === "-m") {
      const value = argv[index + 1];
      if (!value) {
        fail("Missing value for --message.");
      }
      result.message = value;
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    if (!result.bump) {
      result.bump = arg;
      continue;
    }
    fail(`Unexpected argument: ${arg}`);
  }

  if (!result.bump) {
    fail("Usage: node scripts/release.mjs <patch|minor|major|x.y.z> [--dry-run] [--message ...]");
  }

  return result;
}

function printHelp() {
  console.log(`Usage:
  node scripts/release.mjs <patch|minor|major|x.y.z> [--dry-run] [--message "..."] [--skip-checks]

Examples:
  node scripts/release.mjs patch
  node scripts/release.mjs minor --message "release: v0.3.0"
  node scripts/release.mjs 0.3.0 --dry-run`);
}

function parseSemver(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) {
    fail(`Invalid semver version: ${version}`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function bumpVersion(currentVersion, bump) {
  if (/^\d+\.\d+\.\d+$/.test(bump)) {
    return bump;
  }

  const current = parseSemver(currentVersion);
  if (bump === "patch") {
    return `${current.major}.${current.minor}.${current.patch + 1}`;
  }
  if (bump === "minor") {
    return `${current.major}.${current.minor + 1}.0`;
  }
  if (bump === "major") {
    return `${current.major + 1}.0.0`;
  }

  fail(`Unsupported bump target: ${bump}`);
}

function ensureBranch(dryRun) {
  const branch = run("git", ["branch", "--show-current"], { capture: true, dryRun });
  if (!dryRun && branch !== RELEASED_BRANCH) {
    fail(`Releases must be cut from "${RELEASED_BRANCH}". Current branch: "${branch}".`);
  }
}

function syncVersions(currentVersion, nextVersion, dryRun) {
  const packageJson = readJson(PACKAGE_JSON_PATH);
  const packageLock = readJson(PACKAGE_LOCK_PATH);
  const pluginManifest = readJson(OPENCLAW_PLUGIN_PATH);
  const marketplace = readJson(MARKETPLACE_PATH);

  packageJson.version = nextVersion;
  packageLock.version = nextVersion;
  if (packageLock.packages?.[""]) {
    packageLock.packages[""].version = nextVersion;
  }
  pluginManifest.version = nextVersion;
  marketplace.version = nextVersion;
  if (Array.isArray(marketplace.plugins)) {
    for (const plugin of marketplace.plugins) {
      if (plugin?.name === "keep-going") {
        plugin.version = nextVersion;
      }
    }
  }

  if (dryRun) {
    console.log(`[dry-run] would set version ${currentVersion} -> ${nextVersion} in release metadata files`);
    return;
  }

  writeJson(PACKAGE_JSON_PATH, packageJson);
  writeJson(PACKAGE_LOCK_PATH, packageLock);
  writeJson(OPENCLAW_PLUGIN_PATH, pluginManifest);
  writeJson(MARKETPLACE_PATH, marketplace);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const packageJson = readJson(PACKAGE_JSON_PATH);
  const currentVersion = packageJson.version;
  if (typeof currentVersion !== "string" || !currentVersion) {
    fail("package.json is missing a valid version.");
  }

  const nextVersion = bumpVersion(currentVersion, args.bump);
  const commitMessage = args.message ?? `release: v${nextVersion}`;

  ensureBranch(args.dryRun);
  syncVersions(currentVersion, nextVersion, args.dryRun);

  if (!args.skipChecks) {
    run("npm", ["run", "preflight"], { dryRun: args.dryRun });
  } else {
    run("npm", ["run", "build"], { dryRun: args.dryRun });
  }

  run("git", ["add", ...RELEASE_STAGE_PATHS], { dryRun: args.dryRun });
  run("git", ["commit", "-m", commitMessage], { dryRun: args.dryRun });
  run("git", ["push", "origin", "HEAD"], { dryRun: args.dryRun });

  console.log(`Released ${nextVersion}${args.dryRun ? " (dry run)" : ""}.`);
}

main();
