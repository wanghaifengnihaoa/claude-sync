/**
 * Core sync orchestrator for claude-sync.
 * Handles manifest creation, bundle building, and manifest reading.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import * as tar from 'tar';

/**
 * Create a manifest.json object from sync metadata.
 */
export function createManifest(meta, { machineId, sourceUser, sourceHome } = {}) {
  return {
    version: 1,
    pushed_by: machineId || os.hostname(),
    pushed_at: new Date().toISOString(),
    source_user: sourceUser || os.userInfo().username,
    source_home: sourceHome || os.homedir(),
    hashes: meta.files || {},
    mcp_servers: meta.mcp_servers || [],
    plugins: meta.plugins || {},
    skills: meta.skills || {
      skills_sh: [],
      git: [],
      symlink: [],
      child_symlink: [],
      plain: []
    },
    memory: meta.memory || null
  };
}

/**
 * Build a tar.gz bundle from a source directory.
 */
// Directories and files excluded from sync (plan section D: runtime/machine-specific)
const EXCLUDED_ITEMS = new Set([
  'sessions', 'session-env', 'shell-snapshots', 'history.jsonl',
  'projects', 'file-history', 'paste-cache', 'tasks', 'plans',
  'backups', 'debug',
  // Plugin caches (reinstalled on pull)
  'cache', 'marketplaces'
]);

/**
 * Build a tar.gz bundle from a source directory, excluding runtime dirs.
 */
export async function buildBundle(sourceDir, outputPath) {
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const entries = fs.readdirSync(sourceDir).filter(entry => {
    // Exclude top-level forbidden items
    if (EXCLUDED_ITEMS.has(entry)) return false;
    return true;
  });

  await tar.create(
    {
      gzip: true,
      file: outputPath,
      cwd: sourceDir
    },
    entries
  );
}

/**
 * Extract a tar.gz bundle to a target directory.
 */
export async function extractBundle(bundlePath, targetDir) {
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  await tar.extract({
    file: bundlePath,
    cwd: targetDir
  });
}

/**
 * Read and parse a manifest.json file.
 * Returns null if the file doesn't exist or is invalid.
 */
export function readManifest(manifestPath) {
  try {
    if (!fs.existsSync(manifestPath)) {
      return null;
    }
    const content = fs.readFileSync(manifestPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Write a manifest.json file.
 */
export function writeManifest(manifestPath, manifest) {
  const dir = path.dirname(manifestPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

/**
 * Compute sha256 hash of a file.
 */
export function hashFile(filePath) {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Compute sha256 hash of a string.
 */
export function hashString(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}
