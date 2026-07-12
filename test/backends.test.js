import { describe, it, expect, beforeEach } from 'vitest';
import { createRcloneBackend } from '../backends/rclone.js';
import { createManualBackend } from '../backends/manual.js';

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
});
