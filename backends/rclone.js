/**
 * Rclone backend for claude-sync.
 * Supports 40+ cloud storage providers via rclone CLI.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { withRetry } from '../lib/retry.js';

const execFileAsync = promisify(execFile);

export function createRcloneBackend(execFn) {
  const run = execFn || ((cmd, args) => execFileAsync(cmd, args));

  return {
    async upload(filePath, remote) {
      await withRetry(
        async () => {
          try {
            await run('rclone', ['copyto', filePath, remote]);
          } catch (e) {
            throw new Error(`rclone upload failed: ${e.message || e}`);
          }
        },
        { label: 'rclone upload' }
      );
    },

    async download(remote, filePath) {
      await withRetry(
        async () => {
          try {
            await run('rclone', ['copyto', remote, filePath]);
          } catch (e) {
            throw new Error(`rclone download failed: ${e.message || e}`);
          }
        },
        { label: 'rclone download' }
      );
    },

    async listRemotes() {
      try {
        const { stdout } = await run('rclone', ['listremotes']);
        return stdout
          .trim()
          .split('\n')
          .filter(Boolean)
          .map(line => line.replace(/:$/, ''));
      } catch {
        return [];
      }
    },

    async listFolders(remote) {
      try {
        const { stdout } = await run('rclone', ['lsd', `${remote}:`]);
        return stdout
          .trim()
          .split('\n')
          .filter(Boolean)
          .map(line => {
            // rclone lsd output: "        -1 2024-01-01 12:00:00        -1 dirname"
            const parts = line.trim().split(/\s+/);
            return parts[parts.length - 1] + '/';
          });
      } catch {
        return [];
      }
    }
  };
}
