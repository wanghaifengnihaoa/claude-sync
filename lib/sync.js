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
        // Check every path segment against the exclude set.
        // tar normalizes entry paths to '/' on every platform, so splitting on
        // path.sep (which is '\' on Windows) would never match on Windows.
        // Split on either separator to be safe.
        const segments = filePath.split(/[\\/]/);
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
 * Split an installed_plugins.json key into its marketplace suffix, if any.
 * CC format keys are "name@marketplace"; lastIndexOf keeps scoped names
 * intact (@scope/name@marketplace → official; @scope/name → null). Bare names
 * and keys with no marketplace suffix return null.
 */
export function pluginMarketplaceFromKey(key) {
  const at = key.lastIndexOf('@');
  // A trailing `@` (empty marketplace) is a malformed key, not a marketplace.
  return at > 0 && at < key.length - 1 ? key.slice(at + 1) : null;
}

/**
 * Strip the "@marketplace" suffix from an installed_plugins.json key.
 * CC format keys are "name@marketplace"; manifests preserve the full key so
 * pull can install from the right marketplace. This strips it for local
 * matching / display. lastIndexOf keeps scoped names intact
 * (@scope/name@marketplace → @scope/name); bare names and keys with no
 * marketplace suffix pass through unchanged.
 */
export function pluginNameFromKey(key) {
  const at = key.lastIndexOf('@');
  return at > 0 ? key.slice(0, at) : key;
}

/**
 * Index a plugin map by bare plugin name, keeping the marketplace-qualified
 * key for display. Consumers (status/diff/pull) join remote manifest plugins
 * against local installs by the bare name, so this is the single shared way to
 * build that index.
 *
 * Accepts both shapes:
 *   { "name@marketplace": version }                    (readPluginVersions)
 *   { "name@marketplace": { version, installPath, cached } }  (readPluginInstalls)
 * When given install records, `cached` and `installPath` are threaded through
 * so consumers can flag recorded-but-missing installs. `cached` is omitted when
 * unknown (plain version maps), which callers must treat as "assume present".
 */
export function indexPluginsByBareName(pluginMap) {
  const byBare = {};
  for (const [key, entry] of Object.entries(pluginMap || {})) {
    const rec = (typeof entry === 'object' && entry !== null && !Array.isArray(entry))
      ? entry
      : { version: entry };
    // Last-wins: if the same bare name is installed from multiple marketplaces,
    // only the final key is kept. CC records one key per plugin in practice, so
    // this only surfaces on a pathological registry — the "already installed"
    // verdict stays correct, only the hint's marketplace label may be off.
    byBare[pluginNameFromKey(key)] = {
      key,
      version: rec.version,
      ...(rec.cached !== undefined ? { cached: rec.cached } : {}),
      ...(rec.installPath !== undefined ? { installPath: rec.installPath } : {})
    };
  }
  return byBare;
}

/**
 * Pick the "best" install record for a plugin from its CC entries array.
 * Claude Code records the same plugin under multiple scopes (user/local/
 * project) as separate entries; the meaningful one is the user-level record,
 * then the most recently updated. Defensive against entries that aren't the
 * expected shape.
 */
function pickPluginEntry(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return entries;
  const candidates = entries.filter(e => e && typeof e === 'object');
  if (candidates.length === 0) return entries[entries.length - 1];
  // Prefer the user-scope record; fall back through project/local.
  for (const scope of ['user', 'project', 'local']) {
    const scoped = candidates.filter(e => e.scope === scope);
    if (scoped.length > 0) return pickLatest(scoped);
  }
  // Unknown or missing scope: prefer lastUpdated, else the last entry.
  const withScope = candidates.filter(e => typeof e.scope === 'string');
  return pickLatest(withScope.length > 0 ? withScope : candidates);
}

function pickLatest(entries) {
  const dated = entries
    .map((e, i) => ({ e, i, t: Date.parse(e?.lastUpdated) }))
    .filter(x => !Number.isNaN(x.t) && x.t > 0);
  if (dated.length > 0) {
    dated.sort((a, b) => b.t - a.t || b.i - a.i);
    return dated[0].e;
  }
  return entries[entries.length - 1];
}

/**
 * Whether a plugin's files are actually present on disk. The recorded
 * installPath is authoritative when it has content. When it's missing or empty
 * (a restore dropped the cache dir, or the registry was synced from another
 * machine and applyPathReplacement rewrote the path), fall back to this
 * machine's canonical cache layout (cache/<marketplace>/<name> or
 * cache/<name>/<name>) and compare the claimed version against what's cached:
 * - nothing cached → missing, reinstall.
 * - claimed ≤ highest cached semver → already present, leave alone. This is
 *   what converges: a cover pull restores the source's registry record every
 *   time, so a strict equality check against a drifted cache version (source
 *   records 5.1.0, this machine cached 6.3.0) would reinstall on every pull.
 * - claimed > highest cached semver → the plugin is behind, reinstall (the
 *   claude-hud case: registry claims 0.7.1, only 0.7.0 cached).
 * - claimed is not semver (a git SHA) → treat any cache as present; SHA drift
 *   is meaningless to rank and reinstalling would loop.
 */
function pluginCacheExists(pluginsDirPath, key, installPath, version) {
  // Recorded installPath with content is authoritative.
  if (installPath && dirHasContent(installPath)) return true;
  // No recorded installPath (legacy/minimal record): nothing to verify against
  // — treat as present, matching the historical behavior.
  if (!installPath) return true;
  // Nothing cached on this machine at all → missing, reinstall.
  const cached = cachedPluginVersions(pluginsDirPath, key);
  if (cached.length === 0) return false;
  // Cached, but is it the version the registry claims? compare semver:
  //   claimed ≤ highest cached → already present, leave alone. This is what
  //   converges: a cover pull restores the source's registry record every time,
  //   and a strict equality check against a drifted cache version would loop.
  //   claimed > highest cached → the plugin is behind (the claude-hud case:
  //   registry claims 0.7.1, only 0.7.0 cached) → reinstall.
  //   claimed not semver (a git SHA) → treat any cache as present; SHA drift is
  //   meaningless to rank and reinstalling would loop.
  const claimed = parseSemver(version);
  if (!claimed) return true;
  const highest = highestCachedVersion(cached);
  if (!highest) return true;
  return semverLte(claimed, highest);
}

/** Canonical cache directories for a plugin on this machine. */
function canonicalCacheDirs(pluginsDirPath, key) {
  const bare = pluginNameFromKey(key);
  const marketplace = pluginMarketplaceFromKey(key);
  const dirs = [];
  if (marketplace) dirs.push(path.join(pluginsDirPath, 'cache', marketplace, bare));
  dirs.push(path.join(pluginsDirPath, 'cache', bare, bare));
  return dirs;
}

/**
 * Version subdirectories present in this machine's canonical cache layout that
 * actually hold content. A dir name alone is not an install: an interrupted
 * `claude plugin install` can leave an empty version dir, which must not make a
 * claim read as "already present" (or the plugin is never reinstalled nor
 * aligned — stuck at "not cached" with no recovery path).
 */
function cachedPluginVersions(pluginsDirPath, key) {
  const versions = [];
  for (const dir of canonicalCacheDirs(pluginsDirPath, key)) {
    try {
      if (fs.existsSync(dir)) {
        for (const v of fs.readdirSync(dir)) {
          if (dirHasContent(path.join(dir, v))) versions.push(v);
        }
      }
    } catch {
      // Unreadable cache dir — ignore and keep the versions we have.
    }
  }
  return versions;
}

/** Parse a semver prefix ("6.3.0", "0.7.1-rc") to [major, minor, patch], or null. */
function parseSemver(v) {
  if (typeof v !== 'string') return null;
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  return m ? m.slice(1).map(Number) : null;
}

/** Highest cached semver among the version dirs (ignores non-semver entries). */
function highestCachedVersion(cached) {
  let best = null;
  for (const v of cached) {
    const s = parseSemver(v);
    if (!s) continue;
    if (!best || s[0] > best[0] || (s[0] === best[0] && s[1] > best[1]) || (s[0] === best[0] && s[1] === best[1] && s[2] > best[2])) best = s;
  }
  return best;
}

/** a <= b for [major, minor, patch] triples. */
function semverLte(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] < b[i]) return true;
    if (a[i] > b[i]) return false;
  }
  return true;
}

/** A directory that exists and holds at least one entry (a non-empty cache). */
function dirHasContent(dir) {
  try {
    return fs.existsSync(dir) && fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

/**
 * Whether this machine's canonical plugin cache already satisfies the claimed
 * version — i.e. `claude plugin install` has produced something at or above the
 * claim. Used AFTER a reinstall to tell whether the plugin converged, or the
 * marketplace catalog simply cannot reach the claimed version (the source
 * machine's catalog is newer than this machine's). A claim that stays
 * unreachable would otherwise reinstall on every cover pull — loop forever.
 * Semantics mirror pluginCacheExists: SHA claims are satisfied by any cache.
 */
export function cacheSatisfiesVersion(pluginsDirPath, key, version, installPath) {
  // The recorded installPath is authoritative when it has content — mirroring
  // pluginCacheExists so the two verdicts never disagree (a present installPath
  // with an empty canonical cache must still read as satisfied).
  if (installPath && dirHasContent(installPath)) return true;
  const cached = cachedPluginVersions(pluginsDirPath, key);
  if (cached.length === 0) return false;
  const claimed = parseSemver(version);
  if (!claimed) return true; // SHA claim: any cache counts as satisfied
  const highest = highestCachedVersion(cached);
  if (!highest) return true; // cache dirs exist but none semver — nothing to rank
  return semverLte(claimed, highest);
}

/**
 * The actual installed version directory for a plugin on this machine: the
 * highest-semver dir in the canonical cache layout, or a SHA dir when no
 * semver dirs exist, or null when nothing is cached here.
 */
function actualCachedInstall(pluginsDirPath, key) {
  let best = null; // { semver, version, dir }
  let shaFallback = null;
  for (const dir of canonicalCacheDirs(pluginsDirPath, key)) {
    if (!fs.existsSync(dir)) continue;
    let entries;
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const v of entries) {
      const full = path.join(dir, v);
      if (!dirHasContent(full)) continue;
      const s = parseSemver(v);
      if (s) {
        // Strictly-greater than current best (ties keep the earlier dir).
        if (!best || (semverLte(best.semver, s) && !semverLte(s, best.semver))) {
          best = { semver: s, version: v, dir: full };
        }
      } else if (!shaFallback) {
        shaFallback = { version: v, dir: full };
      }
    }
  }
  return best ? { version: best.version, dir: best.dir } : shaFallback;
}

/**
 * Re-point installed_plugins.json records whose recorded installPath is
 * dangling (the directory doesn't exist on this machine) but whose canonical
 * cache actually holds the plugin. A cover pull restores the source's registry
 * record verbatim — claimed version + source installPath — and plugins that are
 * NOT reinstalled (already present at a different version, SHA-cached, or a
 * TTL-cooled claim) keep that record. CC's plugin panel then reads the dangling
 * installPath and reports "not cached at <version>" even though the plugin is
 * installed and usable. Aligning the record to the real cached dir/version makes
 * the panel resolve and keeps status honest (local v<actual> vs remote
 * v<claimed>). Only touches records with a dangling installPath; genuinely
 * missing plugins (nothing cached) are left to the reinstall logic. Returns true
 * when the file was rewritten.
 */
export function alignRegistryToLocalCache(pluginsDirPath) {
  const pluginsPath = path.join(pluginsDirPath, 'installed_plugins.json');
  const raw = readJsonSafe(pluginsPath, {});
  if (!raw || !raw.plugins || typeof raw.plugins !== 'object') return false;
  let changed = false;
  for (const [key, entries] of Object.entries(raw.plugins)) {
    if (!Array.isArray(entries) || entries.length === 0) continue;
    const rec = pickPluginEntry(entries);
    if (!rec || typeof rec !== 'object' || typeof rec.installPath !== 'string') continue;
    if (dirHasContent(rec.installPath)) continue; // installPath already valid
    const actual = actualCachedInstall(pluginsDirPath, key);
    if (!actual) continue; // nothing cached → leave to the reinstall logic
    rec.version = actual.version;
    rec.installPath = actual.dir;
    changed = true;
  }
  if (changed) {
    try {
      fs.writeFileSync(pluginsPath, JSON.stringify(raw, null, 2));
    } catch {
      return false; // write failure: keep the old record rather than half-apply
    }
  }
  return changed;
}

/**
 * Read plugin install records from installed_plugins.json in CC format,
 * including the recorded installPath.
 * Returns a { "name@marketplace": { version, installPath, cached } } map —
 * the full key is preserved so pull can install from the right marketplace.
 *
 * `cached` reflects whether the plugin's files actually exist on disk: true
 * when the recorded installPath exists, when this machine's canonical cache
 * layout holds the plugin, or when neither path can be inspected (no recorded
 * installPath and no canonical layout to check); false only when we know the
 * files are missing — the plugin is recorded but unusable, e.g. after a
 * restore dropped the cache directory while installed_plugins.json survived.
 * Pull must reinstall those rather than trust the record.
 */
export function readPluginInstalls(pluginsDirPath) {
  const pluginsPath = path.join(pluginsDirPath, 'installed_plugins.json');
  const raw = readJsonSafe(pluginsPath, {});
  if (raw && raw.plugins && typeof raw.plugins === 'object') {
    // CC format: { version: 2, plugins: { "name@marketplace": [...] } }
    const result = {};
    for (const [key, entries] of Object.entries(raw.plugins)) {
      const latest = pickPluginEntry(entries);
      const installPath = typeof latest?.installPath === 'string' ? latest.installPath : null;
      result[key] = {
        version: latest?.version || 'unknown',
        installPath,
        cached: pluginCacheExists(pluginsDirPath, key, installPath, latest?.version)
      };
    }
    return result;
  }
  // Legacy flat format: { "plugin-name": "version" } → check canonical layout
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    // Verify it looks like a flat plugin map (all values are strings)
    const allStrings = Object.values(raw).every(v => typeof v === 'string');
    if (allStrings && Object.keys(raw).length > 0) {
      const result = {};
      for (const [k, v] of Object.entries(raw)) result[k] = { version: v, installPath: null, cached: pluginCacheExists(pluginsDirPath, k, null) };
      return result;
    }
  }
  // Unrecognized format: return empty object for safety
  return {};
}

/**
 * Read plugin versions from installed_plugins.json in CC format.
 * Returns a { "name@marketplace": version } map — the full key is preserved
 * so pull can install from the right marketplace. The version is
 * informational only: Claude Code installs the marketplace catalog's current
 * version, not a pinned one.
 */
export function readPluginVersions(pluginsDirPath) {
  const installs = readPluginInstalls(pluginsDirPath);
  const versions = {};
  for (const [key, rec] of Object.entries(installs)) versions[key] = rec.version;
  return versions;
}
