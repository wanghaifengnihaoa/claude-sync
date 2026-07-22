import { describe, it, expect, beforeEach } from 'vitest';
import { createRcloneBackend } from '../backends/rclone.js';
import { createManualBackend } from '../backends/manual.js';
import { createCustomBackend, shellEscape, runShell } from '../backends/custom.js';

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

  it('shellEscape prevents command injection via single-quote wrapping', () => {
    // Inside single quotes, no shell metacharacters are interpreted
    const r1 = shellEscape('$(whoami)');
    // The raw injection payload appears inside single quotes — shell won't execute it
    expect(r1.startsWith("'")).toBe(true);
    expect(r1.endsWith("'")).toBe(true);
    expect(r1).toContain('$(whoami)');

    // Backticks inside single quotes are also safe
    const r2 = shellEscape('`rm -rf /`');
    expect(r2.startsWith("'")).toBe(true);
    expect(r2.endsWith("'")).toBe(true);

    // Single quotes in values are escaped via '\'' idiom
    const r3 = shellEscape("it's a test");
    expect(r3).toContain("\\'");
    expect(r3).toBe("'it'\\''s a test'");
  });
});

// ==============================
// runShell (cross-platform shell routing)
// ==============================
describe('runShell', () => {
  it('Unix: passes the command straight to exec (no wrapper)', async () => {
    let received = null;
    const execAsync = async (cmd) => { received = cmd; return { stdout: '', stderr: '' }; };
    await runShell('scp /tmp/a user@h:/b', { platform: 'darwin', execAsync });
    expect(received).toBe('scp /tmp/a user@h:/b');
  });

  it('Windows: wraps the command in powershell -NoProfile -Command "..."', async () => {
    let received = null;
    const execAsync = async (cmd) => { received = cmd; return { stdout: '', stderr: '' }; };
    await runShell('aws s3 cp \'/path with space/x\' s3://b/x', { platform: 'win32', execAsync });
    expect(received.startsWith('powershell -NoProfile -Command "')).toBe(true);
    expect(received.endsWith('"')).toBe(true);
    // Single quotes pass through unchanged (PowerShell honors them)
    expect(received).toContain("'/path with space/x'");
  });

  it('Windows: escapes embedded double quotes so the -Command argument stays intact', async () => {
    let received = null;
    const execAsync = async (cmd) => { received = cmd; return { stdout: '', stderr: '' }; };
    await runShell('echo "hello"', { platform: 'win32', execAsync });
    // The inner " must be escaped to \" so it doesn't terminate the -Command "..."
    expect(received).toContain('\\"hello\\"');
  });

  it('default platform falls back to process.platform (Unix here)', async () => {
    let received = null;
    const execAsync = async (cmd) => { received = cmd; return { stdout: '', stderr: '' }; };
    await runShell('ls', { execAsync });
    expect(received).toBe('ls');
  });
});
