/**
 * Configuration handling for claude-sync.
 * All defaults are built-in; user config only overrides what they need.
 */

import os from 'node:os';
import path from 'node:path';

export function getDefaultConfig() {
  return {
    BACKEND: 'rclone',
    SECRETS: 'keep',
    MACHINE_ID: os.hostname(),
    EXCLUDE: '',
    BUNDLE_DIR: path.join(os.homedir(), '.claude-sync-bundle'),
    CLAUDE_DIR: path.join(os.homedir(), '.claude'),
    REMOTE_FOLDER: 'claude-sync/',
    HOME: os.homedir()
  };
}

/**
 * Build a full remote path: REMOTE + REMOTE_FOLDER + filename.
 * REMOTE is the backend remote name (e.g. "gdrive:").
 * REMOTE_FOLDER is the folder path within the remote (default "claude-sync/").
 */
export function remotePath(config, filename) {
  const folder = config.REMOTE_FOLDER || 'claude-sync/';
  const remote = config.REMOTE || '';
  return `${remote}${folder}${filename}`;
}

/**
 * Resolve ~ in a path string to the user's home directory.
 */
function expandTilde(p, home = os.homedir()) {
  if (typeof p === 'string' && p.startsWith('~')) {
    // On Windows, ~/foo → p.slice(1) = '/foo', path.join('C:\\Users\\x', '/foo') = 'C:\\foo'
    // Need to also strip the leading slash. On Unix, path.join handles it correctly.
    const rest = p.slice(1);
    if (rest.startsWith('/') || rest.startsWith('\\')) {
      return path.join(home, rest.slice(1));
    }
    return path.join(home, rest);
  }
  return p;
}

/**
 * Read and merge user config with defaults.
 * User config values take precedence over defaults.
 * Path values with ~ are expanded to absolute paths.
 */
export function readConfig(userConfig = {}) {
  const defaults = getDefaultConfig();
  const merged = { ...defaults, ...userConfig };

  // Parse EXCLUDE: accept comma/space-separated string or array; always normalize to array
  if (typeof merged.EXCLUDE === 'string') {
    merged.EXCLUDE = merged.EXCLUDE
      .split(/[, ]+/)
      .map(s => s.trim())
      .filter(Boolean);
  } else if (!Array.isArray(merged.EXCLUDE)) {
    merged.EXCLUDE = [];
  }

  // Expand ~ in path config values (use merged.HOME if set, else os.homedir())
  const home = merged.HOME || os.homedir();
  if (merged.BUNDLE_DIR) merged.BUNDLE_DIR = expandTilde(merged.BUNDLE_DIR, home);
  if (merged.CLAUDE_DIR) merged.CLAUDE_DIR = expandTilde(merged.CLAUDE_DIR, home);

  return merged;
}
