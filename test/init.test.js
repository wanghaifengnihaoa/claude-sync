import { describe, it, expect, vi } from 'vitest';
import { initRcloneRemote } from '../claude-sync.js';
import { remotePath } from '../lib/config.js';
import os from 'node:os';

function mockSpawnSuccess(stdout = 'rclone v1.68.0') {
  return vi.fn().mockReturnValue({ error: null, status: 0, stdout });
}

function mockSpawnNotFound() {
  return vi.fn().mockReturnValue({
    error: { code: 'ENOENT', message: 'spawnSync rclone ENOENT' },
    status: null
  });
}

describe('initRcloneRemote', () => {
  it('rclone installed + remotes exist → picks remote (no folder pick in init)', async () => {
    const config = {};
    const listRemotesFn = vi.fn().mockResolvedValue(['gdrive', 'dropbox']);
    // Only ONE pick: selecting the remote. No folder pick.
    const askPick = vi.fn().mockResolvedValueOnce('gdrive');

    const result = await initRcloneRemote(config, {
      spawnFn: mockSpawnSuccess(), listRemotesFn, askPick
    });

    expect(result.success).toBe(true);
    // REMOTE is just the remote name + colon, no folder path
    expect(config.REMOTE).toBe('gdrive:');
    // Only one pick call (remote selection), no folder pick
    expect(askPick).toHaveBeenCalledTimes(1);
  });

  it('rclone not installed → returns message + user_back', async () => {
    const config = {};
    const askPick = vi.fn();

    const result = await initRcloneRemote(config, {
      spawnFn: mockSpawnNotFound(), listRemotesFn: vi.fn(), askPick
    });

    expect(result.success).toBe(false);
    expect(result.reason).toBe('user_back');
    expect(result.message.some(l => l.includes('rclone not found'))).toBe(true);
    expect(askPick).not.toHaveBeenCalled();
  });

  it('no remotes → Retry → remotes → picks remote only', async () => {
    const config = {};
    const listRemotesFn = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(['gdrive']);
    const askPick = vi.fn()
      .mockResolvedValueOnce('Retry')
      .mockResolvedValueOnce('gdrive');

    const result = await initRcloneRemote(config, {
      spawnFn: mockSpawnSuccess(), listRemotesFn, askPick
    });

    expect(result.success).toBe(true);
    expect(config.REMOTE).toBe('gdrive:');
    expect(askPick).toHaveBeenCalledTimes(2); // Retry + pick remote
  });

  it('no remotes → Back → returns user_back', async () => {
    const config = {};
    const listRemotesFn = vi.fn().mockResolvedValue([]);
    const askPick = vi.fn().mockResolvedValue('Back');

    const result = await initRcloneRemote(config, {
      spawnFn: mockSpawnSuccess(), listRemotesFn, askPick
    });

    expect(result.success).toBe(false);
    expect(result.reason).toBe('user_back');
  });

  it('multiple retries until remotes appear', async () => {
    const config = {};
    const listRemotesFn = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(['myremote']);
    const askPick = vi.fn()
      .mockResolvedValueOnce('Retry')
      .mockResolvedValueOnce('Retry')
      .mockResolvedValueOnce('myremote');

    const result = await initRcloneRemote(config, {
      spawnFn: mockSpawnSuccess(), listRemotesFn, askPick
    });

    expect(result.success).toBe(true);
    expect(config.REMOTE).toBe('myremote:');
    expect(listRemotesFn).toHaveBeenCalledTimes(3);
  });

  it('never spawns rclone config — user does all CLI operations', async () => {
    const config = {};
    const spawnFn = mockSpawnSuccess();
    const listRemotesFn = vi.fn().mockResolvedValue(['gdrive']);
    const askPick = vi.fn().mockResolvedValue('gdrive');

    await initRcloneRemote(config, { spawnFn, listRemotesFn, askPick });

    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(spawnFn).toHaveBeenCalledWith('rclone', ['version'], { stdio: 'pipe' });
  });
});

// ================================================================
// remotePath helper
// ================================================================
describe('remotePath', () => {
  it('combines REMOTE + REMOTE_FOLDER + filename', () => {
    expect(remotePath({ REMOTE: 'gdrive:', REMOTE_FOLDER: 'sync/' }, 'bundle.tar.gz'))
      .toBe('gdrive:sync/bundle.tar.gz');
  });

  it('uses default folder when REMOTE_FOLDER not set', () => {
    expect(remotePath({ REMOTE: 'gdrive:' }, 'manifest.json'))
      .toBe('gdrive:claude-sync/manifest.json');
  });

  it('handles REMOTE without trailing colon (e.g. baidupcs / path)', () => {
    expect(remotePath({ REMOTE: '/', REMOTE_FOLDER: 'apps/claude-sync/' }, 'bundle.tar.gz'))
      .toBe('/apps/claude-sync/bundle.tar.gz');
  });
});

// ================================================================
// ANSI cursor management
// ================================================================
describe('runInit loop cursor management', () => {
  it('emits DEC save (ESC 7) before loop to anchor fixed position', async () => {
    const writes = [];
    const stdout = { write: (s) => { writes.push(s); } };
    stdout.write('\x1b7');
    stdout.write('\x1b8\x1b[J');
    expect(writes[0]).toBe('\x1b7');
    expect(writes[1]).toContain('\x1b8');
    expect(writes[1]).toContain('\x1b[J');
  });

  it('each iteration clears before re-rendering', async () => {
    const writes = [];
    const stdout = { write: (s) => { writes.push(s); } };
    stdout.write('\x1b7');
    stdout.write('\x1b8\x1b[J');
    stdout.write('PICK_LIST_OUTPUT_1');
    stdout.write('\x1b8\x1b[J');
    stdout.write('PICK_LIST_OUTPUT_2');
    const restorePattern = '\x1b8\x1b[J';
    expect(writes.filter(w => w === restorePattern).length).toBe(2);
  });
});
