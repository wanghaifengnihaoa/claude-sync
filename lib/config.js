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
    CLAUDE_DIR: path.join(os.homedir(), '.claude')
  };
}

/**
 * Read and merge user config with defaults.
 * User config values take precedence over defaults.
 */
export function readConfig(userConfig = {}) {
  const defaults = getDefaultConfig();
  return { ...defaults, ...userConfig };
}
