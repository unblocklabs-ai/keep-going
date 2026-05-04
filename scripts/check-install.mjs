#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();

function fail(message) {
  console.error(message);
  process.exit(1);
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), "utf8"));
}

function assertFile(relativePath) {
  const absolutePath = path.join(ROOT, relativePath);
  if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
    fail(`Missing expected file: ${relativePath}`);
  }
}

const packageJson = readJson("package.json");
const pluginManifest = readJson("openclaw.plugin.json");
const marketplace = readJson(".claude-plugin/marketplace.json");

if (!Array.isArray(packageJson.openclaw?.extensions) || packageJson.openclaw.extensions.length === 0) {
  fail("package.json missing openclaw.extensions");
}

for (const extension of packageJson.openclaw.extensions) {
  if (typeof extension !== "string" || !extension.trim()) {
    fail("package.json openclaw.extensions contains an invalid entry");
  }
  assertFile(extension.replace(/^\.\//, ""));
}

if (packageJson.main !== packageJson.openclaw.extensions[0]) {
  fail(`package.json main must match the OpenClaw extension entry: ${packageJson.openclaw.extensions[0]}`);
}

if (!Array.isArray(packageJson.files) || !packageJson.files.includes("dist")) {
  fail('package.json files must include "dist"');
}

if (pluginManifest.id !== "keep-going") {
  fail(`Unexpected openclaw.plugin.json id: ${pluginManifest.id}`);
}

if (pluginManifest.activation?.onStartup !== true) {
  fail("openclaw.plugin.json must set activation.onStartup=true");
}

if (pluginManifest.version !== packageJson.version) {
  fail(`Version mismatch: openclaw.plugin.json=${pluginManifest.version} package.json=${packageJson.version}`);
}

if (marketplace.version !== packageJson.version) {
  fail(`Version mismatch: marketplace=${marketplace.version} package.json=${packageJson.version}`);
}

const marketplacePlugin = Array.isArray(marketplace.plugins)
  ? marketplace.plugins.find((entry) => entry?.name === "keep-going")
  : undefined;
if (!marketplacePlugin) {
  fail("Marketplace manifest missing keep-going plugin entry");
}
if (marketplacePlugin.version !== packageJson.version) {
  fail(`Version mismatch: marketplace plugin=${marketplacePlugin.version} package.json=${packageJson.version}`);
}
if (marketplacePlugin.source !== ".") {
  fail(`Unexpected marketplace source: ${marketplacePlugin.source}`);
}

const importedEntry = await import(pathToFileURL(path.join(ROOT, "dist", "index.js")).href);
if (importedEntry.default?.id !== "keep-going" || typeof importedEntry.default?.register !== "function") {
  fail("dist/index.js default export is not the expected keep-going plugin entry");
}

console.log("Install shape check passed.");
