/**
 * Custom backend for claude-sync.
 * Allows users to define their own upload/download commands in config.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { withRetry, log } from '../lib/retry.js';

const execFileAsync = promisify(execFile);

export function createCustomBackend(config) {
  const uploadCmd = config.UPLOAD_CMD || '';
  const downloadCmd = config.DOWNLOAD_CMD || '';

  return {
    async upload(filePath, remote) {
      if (!uploadCmd) {
        throw new Error('UPLOAD_CMD not configured for custom backend');
      }
      await withRetry(
        async () => {
          try {
            const cmd = uploadCmd.replace('{file}', filePath).replace('{remote}', remote);
            const [exe, ...args] = cmd.split(' ');
            await execFileAsync(exe, args);
            log('verbose', `Custom upload: ${cmd}`);
          } catch (e) {
            throw new Error(`custom upload failed: ${e.message || e}`);
          }
        },
        { label: 'custom upload' }
      );
    },

    async download(remote, filePath) {
      if (!downloadCmd) {
        throw new Error('DOWNLOAD_CMD not configured for custom backend');
      }
      await withRetry(
        async () => {
          try {
            const cmd = downloadCmd.replace('{remote}', remote).replace('{file}', filePath);
            const [exe, ...args] = cmd.split(' ');
            await execFileAsync(exe, args);
            log('verbose', `Custom download: ${cmd}`);
          } catch (e) {
            throw new Error(`custom download failed: ${e.message || e}`);
          }
        },
        { label: 'custom download' }
      );
    }
  };
}
