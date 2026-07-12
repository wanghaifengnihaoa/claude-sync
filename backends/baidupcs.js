/**
 * BaiduPCS (Baidu Netdisk) backend for claude-sync.
 * Uses BaiduPCS-Go CLI for reliable Baidu Netdisk access.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { withRetry } from '../lib/retry.js';

const execFileAsync = promisify(execFile);

export function createBaidupcsBackend(execFn) {
  const run = execFn || defaultExec;

  return {
    async upload(filePath, remoteDir) {
      await withRetry(
        async () => {
          try {
            await run('BaiduPCS-Go', ['upload', filePath, remoteDir]);
          } catch (e) {
            throw new Error(`baidupcs upload failed: ${e.message || e}`);
          }
        },
        { label: 'baidupcs upload' }
      );
    },

    async download(remotePath, filePath) {
      await withRetry(
        async () => {
          try {
            await run('BaiduPCS-Go', ['download', remotePath, '--saveto', filePath]);
          } catch (e) {
            throw new Error(`baidupcs download failed: ${e.message || e}`);
          }
        },
        { label: 'baidupcs download' }
      );
    },

    async checkLogin() {
      try {
        await run('BaiduPCS-Go', ['who']);
        return true;
      } catch {
        return false;
      }
    }
  };
}

async function defaultExec(cmd, args) {
  return execFileAsync(cmd, args);
}
