/**
 * Custom backend for claude-sync.
 * Allows users to define their own upload/download commands in config.
 * Uses shell exec to support quoted arguments and complex commands.
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { withRetry, log } from '../lib/retry.js';

const execAsync = promisify(exec);

/**
 * Create a custom backend with user-defined commands.
 * @param {object} config - backend config with UPLOAD_CMD / DOWNLOAD_CMD
 * @param {function} [execFn] - injectable exec function for testing
 */
export function createCustomBackend(config, execFn) {
  const _exec = execFn || execAsync;
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
            const cmd = uploadCmd.replace(/\{file\}/g, shellEscape(filePath)).replace(/\{remote\}/g, shellEscape(remote));
            await _exec(cmd);
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
            const cmd = downloadCmd.replace(/\{remote\}/g, shellEscape(remote)).replace(/\{file\}/g, shellEscape(filePath));
            await _exec(cmd);
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

/**
 * Escape a value for safe use in a shell command (single-quote wrapping).
 * Inside single quotes, NO characters have special meaning except the single quote itself.
 * The only required escaping: replace ' with '\'' (end quote, escaped quote, restart quote).
 * Shell injection ($(), backticks, etc.) is impossible inside single quotes.
 */
export function shellEscape(val) {
  return `'${String(val).replace(/'/g, "'\\''")}'`;
}
