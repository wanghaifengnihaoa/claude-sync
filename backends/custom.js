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
 * Run a shell command on the appropriate platform shell.
 *
 * Why this exists: shellEscape() wraps values in SINGLE quotes, which only
 * Unix shells understand. Windows' default shell (cmd.exe) does not treat
 * single quotes as quote characters, so a path with spaces (or a single
 * quote) breaks. PowerShell DOES honor single quotes, so on Windows we run
 * the command through `powershell -c` to keep the same escaping working
 * cross-platform. On macOS/Linux we hand the command straight to /bin/sh.
 *
 * @param {string} cmd - fully-formed command string (already shellEscaped)
 * @param {object} [opts]
 * @param {string} [opts.platform] - process.platform override (for tests)
 * @param {function} [opts.execAsync] - promisified exec override (for tests)
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
export async function runShell(cmd, { platform = process.platform, execAsync: doExec = execAsync } = {}) {
  if (platform === 'win32') {
    // PowerShell -Command with the whole command as one argument. We must escape
    // any embedded double quotes so the -c argument stays intact; single quotes
    // inside the command are passed through unchanged (PowerShell honors them).
    const psCmd = cmd.replace(/"/g, '\\"');
    return doExec(`powershell -NoProfile -Command "${psCmd}"`);
  }
  return doExec(cmd);
}

/**
 * Create a custom backend with user-defined commands.
 * @param {object} config - backend config with UPLOAD_CMD / DOWNLOAD_CMD
 * @param {function} [execFn] - injectable exec function for testing.
 *        Signature: async (cmd) => { stdout, stderr }. When provided, runs the
 *        raw command directly (bypassing runShell) so tests can assert cmd text.
 * @param {object} [opts] - extra options
 * @param {string} [opts.platform] - process.platform override (for runShell)
 */
export function createCustomBackend(config, execFn, opts = {}) {
  // Injected execFn (tests) runs the command verbatim; otherwise route through
  // runShell so Windows picks up PowerShell and Unix uses /bin/sh.
  const _exec = execFn
    ? (cmd) => execFn(cmd)
    : (cmd) => runShell(cmd, { platform: opts.platform });
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
