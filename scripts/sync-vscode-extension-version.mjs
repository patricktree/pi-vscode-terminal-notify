#!/usr/bin/env node

/**
 * Sync the version of packages/vscode-extension with packages/vscode-extension-core.
 *
 * After `pnpm exec changeset version` bumps vscode-extension-core, run this script
 * to update vscode-extension's own version and its pinned dependency on the core package.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const corePkgPath = resolve(
  root,
  "packages/vscode-extension-core/package.json",
);
const extPkgPath = resolve(root, "packages/vscode-extension/package.json");

const corePkg = JSON.parse(readFileSync(corePkgPath, "utf-8"));
const extPkg = JSON.parse(readFileSync(extPkgPath, "utf-8"));

const newVersion = corePkg.version;
const depName = corePkg.name;

const oldExtVersion = extPkg.version;
const oldDepVersion = extPkg.dependencies?.[depName];

extPkg.version = newVersion;
if (extPkg.dependencies?.[depName] !== undefined) {
  extPkg.dependencies[depName] = newVersion;
}

writeFileSync(extPkgPath, JSON.stringify(extPkg, null, 2) + "\n");

console.log(
  `Synced packages/vscode-extension: version ${oldExtVersion} → ${newVersion}, ` +
    `dep ${depName} ${oldDepVersion} → ${newVersion}`,
);
