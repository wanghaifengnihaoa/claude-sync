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
    HOME: os.homedir()
  };
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

  // Expand ~ in path config values (use merged.HOME if set, else os.homedir())
  const home = merged.HOME || os.homedir();
  if (merged.BUNDLE_DIR) merged.BUNDLE_DIR = expandTilde(merged.BUNDLE_DIR, home);
  if (merged.CLAUDE_DIR) merged.CLAUDE_DIR = expandTilde(merged.CLAUDE_DIR, home);

  return merged;
}
