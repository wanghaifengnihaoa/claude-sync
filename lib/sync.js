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
    claude_version: meta.claude_version || null,
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
const BUILTIN_EXCLUDES = new Set([
  'sessions', 'session-env', 'shell-snapshots', 'history.jsonl',
  'projects', 'file-history', 'paste-cache', 'tasks', 'plans',
  'backups', 'debug',
  // Plugin caches (reinstalled on pull)
  'cache', 'marketplaces'
]);

/**
 * Build a tar.gz bundle from a source directory, excluding runtime dirs.
 * @param {string} sourceDir - the source directory to bundle
 * @param {string} outputPath - path for the output .tar.gz
 * @param {string[]} [additionalExcludes=[]] - additional directory/file names to exclude (matched against every path segment)
 */
export async function buildBundle(sourceDir, outputPath, additionalExcludes = []) {
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Merge built-in and user-configured excludes
  const allExcludes = new Set([...BUILTIN_EXCLUDES, ...additionalExcludes]);

  await tar.create(
    {
      gzip: true,
      file: outputPath,
      cwd: sourceDir,
      filter: (filePath) => {
        // Check every path segment against the exclude set
        const segments = filePath.split(path.sep);
        return !segments.some(seg => allExcludes.has(seg));
      }
    },
    ['.']
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

/**
 * Safely read and parse a JSON file.
 * Returns defaultValue if the file doesn't exist or is invalid.
 */
export function readJsonSafe(filePath, defaultValue = null) {
  try {
    if (!fs.existsSync(filePath)) return defaultValue;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return defaultValue;
  }
}

/**
 * Read plugin versions from installed_plugins.json in CC format.
 * Returns a flat { name: version } map.
 */
export function readPluginVersions(pluginsDirPath) {
  const pluginsPath = path.join(pluginsDirPath, 'installed_plugins.json');
  const raw = readJsonSafe(pluginsPath, {});
  if (raw.plugins && typeof raw.plugins === 'object') {
    // CC format: { version: 2, plugins: { "name@marketplace": [...] } }
    const result = {};
    for (const [key, entries] of Object.entries(raw.plugins)) {
      const name = key.split('@')[0];
      const latest = Array.isArray(entries) ? entries[entries.length - 1] : entries;
      result[name] = latest?.version || 'unknown';
    }
    return result;
  }
  // Legacy flat format: { "plugin-name": "version" } → return as-is
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    // Verify it looks like a flat plugin map (all values are strings)
    const allStrings = Object.values(raw).every(v => typeof v === 'string');
    if (allStrings && Object.keys(raw).length > 0) {
      return raw;
    }
  }
  // Unrecognized format: return empty object for safety
  return {};
}
