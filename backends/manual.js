/**
 * Manual backend for claude-sync.
 * Only packs/unpacks — user handles upload/download manually.
 * Useful for iCloud Drive and other sync folders.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

export function createManualBackend({ copyFile, bundleDir } = {}) {
  const copy = copyFile || fs.copyFile;
  const dir = bundleDir || path.join(process.env.HOME || '~', '.claude-sync-bundle');

  return {
    async upload(filePath, _remote) {
      try {
        const basename = path.basename(filePath);
        const dest = path.join(dir, basename);
        await copy(filePath, dest);
      } catch (e) {
        throw new Error(`manual upload failed: ${e.message || e}`);
      }
    },

    async download(remote, filePath) {
      try {
        const src = path.isAbsolute(remote)
          ? (remote.startsWith(dir) ? remote : path.join(dir, path.basename(remote)))
          : path.join(dir, remote);
        // Prevent path traversal outside bundleDir
        const resolvedSrc = path.resolve(src);
        const resolvedDir = path.resolve(dir);
        if (!resolvedSrc.startsWith(resolvedDir + path.sep) && resolvedSrc !== resolvedDir) {
          throw new Error(`manual download blocked: '${remote}' resolves outside bundle directory`);
        }
        await copy(src, filePath);
      } catch (e) {
        throw new Error(`manual download failed: ${e.message || e}`);
      }
    },

    getBundleDir() {
      return dir;
    }
  };
}
