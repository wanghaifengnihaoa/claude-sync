import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Regression for the "silently continued pull after a failed Claude upgrade"
// bug: installClaude used to swallow errors and return normally, and the
// caller then returned 'continue' unconditionally — so an install that failed
// (e.g. EBUSY because claude.exe is running on Windows) still let the pull
// proceed as if Claude had been upgraded. installClaude now returns a boolean
// and the caller loops instead of continuing. Mock child_process so the tests
// are fully deterministic (no real npm installs / tasklist).

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
  execFileSync: vi.fn()
}));

import { execFileSync } from 'node:child_process';
import { installClaude } from '../lib/workflow.js';

const realPlatform = process.platform;

describe('installClaude', () => {
  let tasklistHasClaude;
  let installedVersion;
  let npmError;

  beforeEach(() => {
    // Force the Windows code path (tasklist detection) regardless of host.
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    tasklistHasClaude = false;
    installedVersion = '2.1.229';
    npmError = null;

    vi.clearAllMocks();
    execFileSync.mockImplementation((cmd) => {
      if (cmd === 'tasklist') {
        if (tasklistHasClaude) return 'claude.exe 33112 Console 2 592,168 K';
        const e = new Error('Command failed: tasklist');
        e.status = 1; // no matching process → tasklist exits 1
        throw e;
      }
      if (cmd === 'claude') return `${installedVersion} (Claude Code)`;
      if (cmd === 'npm') {
        if (npmError) throw npmError;
        return '';
      }
      throw new Error(`unexpected cmd: ${cmd}`);
    });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  });

  it('returns false and does NOT run npm when claude.exe is running (Windows lock)', async () => {
    tasklistHasClaude = true;
    const ok = await installClaude('2.1.229');
    expect(ok).toBe(false);
    expect(execFileSync).not.toHaveBeenCalledWith('npm', expect.anything(), expect.anything());
  });

  it('returns false when npm throws EBUSY/ETIMEDOUT', async () => {
    npmError = new Error('spawnSync C:\\windows\\system32\\cmd.exe ETIMEDOUT');
    const ok = await installClaude('2.1.229');
    expect(ok).toBe(false);
  });

  it('returns true only when install succeeds AND the version actually changed', async () => {
    const ok = await installClaude('2.1.229');
    expect(ok).toBe(true);
    expect(execFileSync).toHaveBeenCalledWith(
      'npm',
      ['install', '-g', '@anthropic-ai/claude-code@2.1.229'],
      expect.objectContaining({ shell: true })
    );
  });

  it('returns false when install succeeded but claude --version is unchanged', async () => {
    installedVersion = '2.1.224'; // npm "succeeded" but the CLI on PATH didn't change
    const ok = await installClaude('2.1.229');
    expect(ok).toBe(false);
  });
});
