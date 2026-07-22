import { describe, it, expect, vi } from 'vitest';
import { initRcloneRemote, resolveManualBundleDir, confirmManualBundleDir, detectCloudDirs } from '../claude-sync.js';
import path from 'node:path';
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

  it('handles REMOTE without trailing colon (e.g. root path)', () => {
    expect(remotePath({ REMOTE: '/', REMOTE_FOLDER: 'apps/claude-sync/' }, 'bundle.tar.gz'))
      .toBe('/apps/claude-sync/bundle.tar.gz');
  });
});

// ================================================================
// resolveManualBundleDir (init)
// ================================================================
describe('resolveManualBundleDir', () => {
  const home = '/Users/test';

  it('empty answer → platform default under home', async () => {
    const askText = vi.fn().mockResolvedValue('');
    const dir = await resolveManualBundleDir({ HOME: home }, { askText, home });
    expect(dir).toBe('/Users/test/.claude-sync-bundle');
  });

  it('empty answer → keeps existing configured BUNDLE_DIR as default', async () => {
    const askText = vi.fn().mockResolvedValue('   '); // whitespace = no input
    const dir = await resolveManualBundleDir({ HOME: home, BUNDLE_DIR: '/existing/dir' }, { askText, home });
    expect(dir).toBe('/existing/dir');
  });

  it('expands a leading ~ in the typed path (iCloud interior ~ preserved)', async () => {
    const askText = vi.fn().mockResolvedValue('~/Library/Mobile Documents/com~apple~CloudDocs/claude-sync');
    const dir = await resolveManualBundleDir({ HOME: home }, { askText, home });
    expect(dir).toBe('/Users/test/Library/Mobile Documents/com~apple~CloudDocs/claude-sync');
  });

  it('keeps an absolute typed path as-is', async () => {
    const askText = vi.fn().mockResolvedValue('/mnt/usb/backup');
    const dir = await resolveManualBundleDir({ HOME: home }, { askText, home });
    expect(dir).toBe('/mnt/usb/backup');
  });
});

// ================================================================
// confirmManualBundleDir (push/pull)
// ================================================================
describe('confirmManualBundleDir', () => {
  const home = '/Users/test';

  it('empty answer → confirms current dir, changed=false', async () => {
    const askText = vi.fn().mockResolvedValue('');
    const res = await confirmManualBundleDir({ BUNDLE_DIR: '/cur/dir', HOME: home }, { askText, home });
    expect(res).toEqual({ bundleDir: '/cur/dir', changed: false });
  });

  it('typing the same path → changed=false', async () => {
    const askText = vi.fn().mockResolvedValue('/cur/dir');
    const res = await confirmManualBundleDir({ BUNDLE_DIR: '/cur/dir', HOME: home }, { askText, home });
    expect(res.changed).toBe(false);
    expect(res.bundleDir).toBe('/cur/dir');
  });

  it('new path → changed=true and expands ~', async () => {
    const askText = vi.fn().mockResolvedValue('~/Desktop/newbundle');
    const res = await confirmManualBundleDir({ BUNDLE_DIR: '/cur/dir', HOME: home }, { askText, home });
    expect(res.changed).toBe(true);
    expect(res.bundleDir).toBe('/Users/test/Desktop/newbundle');
  });

  it('falls back to platform default when BUNDLE_DIR missing', async () => {
    const askText = vi.fn().mockResolvedValue('');
    const res = await confirmManualBundleDir({ HOME: home }, { askText, home });
    expect(res.bundleDir).toBe('/Users/test/.claude-sync-bundle');
    expect(res.changed).toBe(false);
  });

  it('passes the verb into the prompt text', async () => {
    const askText = vi.fn().mockResolvedValue('');
    await confirmManualBundleDir({ BUNDLE_DIR: '/cur', HOME: home }, { askText, verb: 'pulled from', home });
    expect(askText.mock.calls[0][0]).toContain('pulled from');
  });
});

// ================================================================
// detectCloudDirs
// ================================================================
describe('detectCloudDirs', () => {
  const home = '/Users/test';
  const iCloud = path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
  const cloudStorage = path.join(home, 'Library', 'CloudStorage');

  it('macOS: detects iCloud Drive when it exists', () => {
    const existsSync = (p) => p === iCloud;
    const found = detectCloudDirs({ home, existsSync, platform: 'darwin' });
    expect(found).toEqual([{ label: 'iCloud Drive', dir: iCloud }]);
  });

  it('macOS: detects OneDrive with dynamic suffix via CloudStorage scan', () => {
    // OneDrive-Personal / OneDrive-<Company> — suffix is dynamic, must prefix-match
    const existsSync = (p) => p === cloudStorage;
    const readdirSync = () => ['OneDrive-Personal'];
    const found = detectCloudDirs({ home, existsSync, readdirSync, platform: 'darwin' });
    expect(found).toEqual([
      { label: 'OneDrive (Personal)', dir: path.join(cloudStorage, 'OneDrive-Personal') }
    ]);
  });

  it('macOS: detects Google Drive with email suffix (GoogleDrive-<email>)', () => {
    const existsSync = (p) => p === cloudStorage;
    const readdirSync = () => ['GoogleDrive-me@gmail.com'];
    const found = detectCloudDirs({ home, existsSync, readdirSync, platform: 'darwin' });
    expect(found).toEqual([
      { label: 'Google Drive (me@gmail.com)', dir: path.join(cloudStorage, 'GoogleDrive-me@gmail.com') }
    ]);
  });

  it('macOS: detects multiple CloudStorage entries at once', () => {
    const existsSync = (p) => p === cloudStorage;
    const readdirSync = () => ['OneDrive-Contoso', 'GoogleDrive-a@b.com', 'SomethingElse'];
    const found = detectCloudDirs({ home, existsSync, readdirSync, platform: 'darwin' });
    expect(found.map(f => f.label)).toEqual(['OneDrive (Contoso)', 'Google Drive (a@b.com)']);
  });

  it('Windows: detects ~/OneDrive', () => {
    const oneDrive = path.join(home, 'OneDrive');
    const existsSync = (p) => p === oneDrive;
    const found = detectCloudDirs({ home, existsSync, platform: 'win32' });
    expect(found).toEqual([{ label: 'OneDrive', dir: oneDrive }]);
  });

  it('Windows: detects iCloud Drive with a space (official name)', () => {
    const iCloudWin = path.join(home, 'iCloud Drive');
    const existsSync = (p) => p === iCloudWin;
    const found = detectCloudDirs({ home, existsSync, platform: 'win32' });
    expect(found).toEqual([{ label: 'iCloud Drive', dir: iCloudWin }]);
  });

  it('detects Dropbox on any platform', () => {
    const dropbox = path.join(home, 'Dropbox');
    const existsSync = (p) => p === dropbox;
    const found = detectCloudDirs({ home, existsSync, platform: 'darwin' });
    expect(found).toEqual([{ label: 'Dropbox', dir: dropbox }]);
  });

  it('returns empty when nothing exists', () => {
    const found = detectCloudDirs({ home, existsSync: () => false, platform: 'darwin' });
    expect(found).toEqual([]);
  });
});

// ================================================================
// resolveManualBundleDir — cloud detection branch
// ================================================================
describe('resolveManualBundleDir with cloud detection', () => {
  const home = '/Users/test';
  const iCloud = path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
  const iCloudBundle = path.join(iCloud, 'claude-sync');

  it('picks a detected cloud folder → returns its claude-sync subdir', async () => {
    const existsSync = (p) => p === iCloud;
    const askText = vi.fn();
    // pickList returns the first item (the iCloud choice)
    const pickList = vi.fn((q, items) => Promise.resolve(items[0]));
    const dir = await resolveManualBundleDir({ HOME: home }, {
      askText, pickList, existsSync, platform: 'darwin', home
    });
    expect(dir).toBe(iCloudBundle);
    expect(askText).not.toHaveBeenCalled(); // no free-text prompt when picking a cloud
  });

  it('picks "Local only" → returns platform default', async () => {
    const existsSync = (p) => p === iCloud;
    const askText = vi.fn();
    const pickList = vi.fn((q, items) => Promise.resolve(items.find(i => i.startsWith('Local only'))));
    const dir = await resolveManualBundleDir({ HOME: home }, {
      askText, pickList, existsSync, platform: 'darwin', home
    });
    expect(dir).toBe(path.join(home, '.claude-sync-bundle'));
  });

  it('picks "Custom path..." → falls back to text prompt (with ~ expansion)', async () => {
    const existsSync = (p) => p === iCloud;
    const askText = vi.fn().mockResolvedValue('~/mybundle');
    const pickList = vi.fn((q, items) => Promise.resolve(items.find(i => i.startsWith('Custom'))));
    const dir = await resolveManualBundleDir({ HOME: home }, {
      askText, pickList, existsSync, platform: 'darwin', home
    });
    expect(dir).toBe(path.join(home, 'mybundle'));
  });

  it('no cloud detected → uses plain text prompt directly', async () => {
    const askText = vi.fn().mockResolvedValue('/mnt/usb');
    const pickList = vi.fn();
    const dir = await resolveManualBundleDir({ HOME: home }, {
      askText, pickList, existsSync: () => false, platform: 'darwin', home
    });
    expect(dir).toBe('/mnt/usb');
    expect(pickList).not.toHaveBeenCalled();
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
