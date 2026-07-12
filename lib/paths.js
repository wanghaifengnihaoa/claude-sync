/**
 * Path utilities for claude-sync.
 * Handles cross-platform user path replacement (macOS, Linux, Windows).
 */

import os from 'node:os';

/**
 * Replace source home directory prefix with target home directory prefix.
 * Cross-platform: handles /Users/<name> (macOS), /home/<name> (Linux),
 * and C:\Users\<name> (Windows).
 */
export function replaceUserPath(content, sourceHome, targetHome) {
  if (typeof content !== 'string') return content;
  // Escape both home paths for regex
  const escapedSource = escapeRegExp(sourceHome);
  // Replace source home prefix with target home prefix (as path prefix, not substring)
  const pattern = new RegExp(escapedSource + '(?=/|\\\\|$)', 'g');
  return content.replace(pattern, targetHome);
}

/**
 * Normalize a path: replace home directory prefix with ~ for display.
 */
export function normalizeHomeDir(filepath, homeDir) {
  const hd = homeDir || os.homedir();
  if (filepath.startsWith(hd + '/') || filepath.startsWith(hd + '\\')) {
    return '~' + filepath.slice(hd.length);
  }
  return filepath;
}

/**
 * Get the home directory prefix pattern for a given home path.
 * Returns the path separator-stripped prefix for matching.
 */
export function getHomePrefix(homeDir) {
  return homeDir;
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
