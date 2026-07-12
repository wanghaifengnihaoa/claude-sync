import { describe, it, expect, beforeEach } from 'vitest';
import { createRcloneBackend } from '../backends/rclone.js';
import { createManualBackend } from '../backends/manual.js';
import { createBaidupcsBackend } from '../backends/baidupcs.js';
import { createCustomBackend, shellEscape } from '../backends/custom.js';

// Helper to create a backend with a fake exec for testing
function fakeExec(responses) {
  return async (cmd, args) => {
    const key = `${cmd} ${args.join(' ')}`;
    if (responses[key]) {
      const resp = responses[key];
      if (resp instanceof Error) throw resp;
      return resp;
    }
    throw new Error(`Unexpected exec call: ${key}`);
  };
}

describe('rclone backend', () => {
  it('upload calls rclone copyto with correct arguments', async () => {
    const calls = [];
    const exec = async (cmd, args) => {
      calls.push({ cmd, args });
      return { stdout: '', stderr: '' };
    };

    const backend = createRcloneBackend(exec);
    await backend.upload('/tmp/bundle.tar.gz', 'myremote:claude-sync/bundle.tar.gz');

    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe('rclone');
    expect(calls[0].args).toContain('copyto');
    expect(calls[0].args).toContain('/tmp/bundle.tar.gz');
    expect(calls[0].args).toContain('myremote:claude-sync/bundle.tar.gz');
  });

  it('download calls rclone copyto with reversed args', async () => {
    const calls = [];
    const exec = async (cmd, args) => {
      calls.push({ cmd, args });
      return { stdout: '', stderr: '' };
    };

    const backend = createRcloneBackend(exec);
    await backend.download('myremote:claude-sync/bundle.tar.gz', '/tmp/bundle.tar.gz');

    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe('rclone');
    expect(calls[0].args).toContain('copyto');
    expect(calls[0].args).toContain('myremote:claude-sync/bundle.tar.gz');
    expect(calls[0].args).toContain('/tmp/bundle.tar.gz');
  });

  it('upload throws when rclone fails', { timeout: 15000 }, async () => {
    const exec = fakeExec({
      'rclone copyto /tmp/bundle.tar.gz myremote:claude-sync/bundle.tar.gz':
        new Error('rclone: command not found')
    });

    const backend = createRcloneBackend(exec);
    await expect(
      backend.upload('/tmp/bundle.tar.gz', 'myremote:claude-sync/bundle.tar.gz')
    ).rejects.toThrow('rclone upload failed');
  });

  it('listRemotes parses rclone listremotes output', async () => {
    const exec = async (cmd, args) => {
      if (cmd === 'rclone' && args.includes('listremotes')) {
        return {
          stdout: 'myremote:\ngdrive:\n',
          stderr: ''
        };
      }
      throw new Error('unexpected');
    };

    const backend = createRcloneBackend(exec);
    const remotes = await backend.listRemotes();
    expect(remotes).toEqual(['myremote', 'gdrive']);
  });

  it('listRemotes returns empty array when no remotes configured', async () => {
    const exec = async (cmd, args) => {
      return { stdout: '', stderr: '' };
    };

    const backend = createRcloneBackend(exec);
    const remotes = await backend.listRemotes();
    expect(remotes).toEqual([]);
  });
});

describe('manual backend', () => {
  it('upload copies file to bundle dir with correct name', async () => {
    const copied = [];
    const backend = createManualBackend({
      copyFile: async (src, dest) => { copied.push({ src, dest }); },
      bundleDir: '/tmp/claude-sync-bundle'
    });

    await backend.upload('/tmp/bundle.tar.gz', '');

    expect(copied).toHaveLength(1);
    expect(copied[0].src).toBe('/tmp/bundle.tar.gz');
    expect(copied[0].dest).toContain('bundle.tar.gz');
  });

  it('download copies file from bundle dir to local path', async () => {
    const copied = [];
    const backend = createManualBackend({
      copyFile: async (src, dest) => { copied.push({ src, dest }); },
      bundleDir: '/tmp/claude-sync-bundle'
    });

    await backend.download('bundle.tar.gz', '/tmp/restored.tar.gz');

    expect(copied).toHaveLength(1);
    expect(copied[0].src).toContain('bundle.tar.gz');
    expect(copied[0].dest).toBe('/tmp/restored.tar.gz');
  });

  it('download throws when remote file does not exist', async () => {
    const backend = createManualBackend({
      copyFile: async () => { throw new Error('ENOENT'); },
      bundleDir: '/tmp/claude-sync-bundle'
    });

    await expect(
      backend.download('nonexistent.tar.gz', '/tmp/out.tar.gz')
    ).rejects.toThrow('manual download failed');
  });

  it('blocks path traversal in download', async () => {
    const backend = createManualBackend({
      copyFile: async () => {},
      bundleDir: '/tmp/claude-sync-bundle'
    });

    await expect(
      backend.download('../../../etc/passwd', '/tmp/out')
    ).rejects.toThrow('manual download failed');
  });
});

// ==============================
// baidupcs backend
// ==============================
describe('baidupcs backend', () => {
  it('upload calls BaiduPCS-Go upload with correct arguments', async () => {
    const calls = [];
    const exec = async (cmd, args) => {
      calls.push({ cmd, args });
      return { stdout: '', stderr: '' };
    };

    const backend = createBaidupcsBackend(exec);
    await backend.upload('/tmp/bundle.tar.gz', '/claude-sync');

    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe('BaiduPCS-Go');
    expect(calls[0].args).toContain('upload');
    expect(calls[0].args).toContain('/tmp/bundle.tar.gz');
    expect(calls[0].args).toContain('/claude-sync');
  });

  it('download calls BaiduPCS-Go download with correct arguments', async () => {
    const calls = [];
    const exec = async (cmd, args) => {
      calls.push({ cmd, args });
      return { stdout: '', stderr: '' };
    };

    const backend = createBaidupcsBackend(exec);
    await backend.download('/claude-sync/bundle.tar.gz', '/tmp/bundle.tar.gz');

    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe('BaiduPCS-Go');
    expect(calls[0].args).toContain('download');
    expect(calls[0].args).toContain('/claude-sync/bundle.tar.gz');
  });

  it('checkLogin returns true when BaiduPCS-Go who succeeds', async () => {
    const exec = async () => ({ stdout: 'Logged in', stderr: '' });
    const backend = createBaidupcsBackend(exec);
    const result = await backend.checkLogin();
    expect(result).toBe(true);
  });

  it('checkLogin returns false when BaiduPCS-Go who fails', async () => {
    const exec = async () => { throw new Error('not logged in'); };
    const backend = createBaidupcsBackend(exec);
    const result = await backend.checkLogin();
    expect(result).toBe(false);
  });

  it('upload throws when BaiduPCS-Go fails', { timeout: 15000 }, async () => {
    const exec = fakeExec({
      'BaiduPCS-Go upload /tmp/bundle.tar.gz /claude-sync':
        new Error('BaiduPCS-Go: not found')
    });

    const backend = createBaidupcsBackend(exec);
    await expect(
      backend.upload('/tmp/bundle.tar.gz', '/claude-sync')
    ).rejects.toThrow('baidupcs upload failed');
  });
});

// ==============================
// custom backend
// ==============================
describe('custom backend', () => {
  it('upload substitutes {file} and {remote} and calls injected execFn', async () => {
    let executedCmd = '';
    const exec = async (cmd) => {
      executedCmd = cmd;
      return { stdout: '', stderr: '' };
    };

    const backend = createCustomBackend({
      UPLOAD_CMD: 'scp {file} user@host:{remote}',
      DOWNLOAD_CMD: ''
    }, exec);

    await backend.upload('/tmp/my file.tar.gz', '/remote/path');
    expect(executedCmd).toContain('scp ');
    expect(executedCmd).toContain('user@host:');
  });

  it('download substitutes {remote} and {file} and calls injected execFn', async () => {
    let executedCmd = '';
    const exec = async (cmd) => {
      executedCmd = cmd;
      return { stdout: '', stderr: '' };
    };

    const backend = createCustomBackend({
      UPLOAD_CMD: '',
      DOWNLOAD_CMD: 'wget {remote} -O {file}'
    }, exec);

    await backend.download('https://example.com/bundle.tar.gz', '/tmp/out.tar.gz');
    expect(executedCmd).toContain('wget ');
    expect(executedCmd).toContain('-O ');
  });

  it('upload throws when UPLOAD_CMD is not configured', async () => {
    const backend = createCustomBackend({ UPLOAD_CMD: '', DOWNLOAD_CMD: '' });
    await expect(
      backend.upload('/tmp/file', 'remote-path')
    ).rejects.toThrow('UPLOAD_CMD not configured');
  });

  it('download throws when DOWNLOAD_CMD is not configured', async () => {
    const backend = createCustomBackend({ UPLOAD_CMD: '', DOWNLOAD_CMD: '' });
    await expect(
      backend.download('remote-path', '/tmp/file')
    ).rejects.toThrow('DOWNLOAD_CMD not configured');
  });

  it('shellEscape prevents command injection via $(), backticks, and quotes', () => {
    const r1 = shellEscape('$(whoami)');
    expect(r1).toContain('\\$');
    const r2 = shellEscape('`rm -rf /`');
    expect(r2).toContain('\\`');
    const r3 = shellEscape('test"evil');
    expect(r3).toContain('\\"');
    const r4 = shellEscape("it's a test");
    expect(r4).toContain("\\'");
  });
});
