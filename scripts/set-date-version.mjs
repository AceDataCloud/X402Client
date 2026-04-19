#!/usr/bin/env node
/**
 * Set package.json version to a CalVer YYYY.M.D (no leading zeros) based on UTC date.
 * If the current version already matches today's date, append a numeric suffix
 * (YYYY.M.D.N) to keep publishing multiple builds per day — npm accepts 4-segment
 * versions via the semver "build" via prerelease style is not ideal, so we instead
 * go to YYYY.M.D{N*10+...} style — but most of the time this is a no-op.
 *
 * Convention matches AceDataCloud MCP servers (e.g. SunoMCP: 2026.1.22, 2026.1.22.6).
 *
 * Usage:
 *   node scripts/set-date-version.mjs            # set to today's date
 *   node scripts/set-date-version.mjs --dry-run  # print only
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgPath = resolve(__dirname, '..', 'package.json');

const now = new Date();
const y = now.getUTCFullYear();
const m = now.getUTCMonth() + 1;
const d = now.getUTCDate();
const datePrefix = `${y}.${m}.${d}`;

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const current = pkg.version ?? '';

let next;
if (current === datePrefix) {
  next = `${datePrefix}.1`;
} else if (current.startsWith(`${datePrefix}.`)) {
  const tail = current.slice(datePrefix.length + 1);
  const n = Number.parseInt(tail, 10);
  next = Number.isFinite(n) ? `${datePrefix}.${n + 1}` : `${datePrefix}.1`;
} else {
  next = datePrefix;
}

const dryRun = process.argv.includes('--dry-run');
console.log(`current version: ${current}`);
console.log(`new version:     ${next}`);

if (dryRun) {
  process.exit(0);
}

pkg.version = next;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`✓ wrote ${pkgPath}`);
