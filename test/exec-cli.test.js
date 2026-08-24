import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execCli } from '../lib/workflow.js';

// Regression tests for the Windows execCli bug (PR #2): execFileSync with
// shell:true on Windows joins args with spaces WITHOUT quoting — a path with a
// space splits into two args, and `&`/`|`/`%` etc. get interpreted by cmd.exe
// (command injection). The fix routes the win32 branch through cross-spawn,
// which resolves `.cmd` shims and quotes args correctly. These tests force the
// win32 branch on any platform so the guard runs everywhere, not just Windows CI.

// `-e` script that prints its positionals as JSON so we can assert arg integrity.
const ECHO_ARGV = 'console.log(JSON.stringify(process.argv.slice(1)))';

describe('execCli — win32 arg quoting', () => {
  it('keeps an arg containing spaces intact (no word-splitting)', () => {
    const out = execCli(process.execPath, ['-e', ECHO_ARGV, 'hello world'], { encoding: 'utf8' }, { platform: 'win32' });
    expect(JSON.parse(out.trim())).toEqual(['hello world']);
  });

  it('keeps a Windows path with spaces intact', () => {
    const dest = path.join(os.tmpdir(), 'claude-sync exec cli dest'); // real space on every platform
    const out = execCli(process.execPath, ['-e', ECHO_ARGV, dest], { encoding: 'utf8' }, { platform: 'win32' });
    expect(JSON.parse(out.trim())).toEqual([dest]);
  });

  it('does not interpret shell metacharacters in an arg (& / | / >)', () => {
    const out = execCli(process.execPath, ['-e', 'console.log(process.argv[1])', 'x&echo INJECTED'], { encoding: 'utf8' }, { platform: 'win32' });
    expect(out.trim()).toBe('x&echo INJECTED');
  });

  it('does not expand %VAR% in an arg', () => {
    const out = execCli(process.execPath, ['-e', 'console.log(process.argv[1])', 'a%PATH%b'], { encoding: 'utf8' }, { platform: 'win32' });
    expect(out.trim()).toBe('a%PATH%b');
  });

  it('throws with the exit status on a non-zero exit', () => {
    let caught = null;
    try {
      execCli(process.execPath, ['-e', 'process.exit(3)'], { encoding: 'utf8' }, { platform: 'win32' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught.status).toBe(3);
  });

  it('spawn errors expose a null status, matching execFileSync', () => {
    // execFileSync's spawn-error (e.g. ENOENT) contract sets err.status null;
    // the win32 branch must not surface undefined where the POSIX branch gives null.
    let caught = null;
    try {
      execCli('definitely-not-a-real-command-xyz-12345', [], {}, { platform: 'win32' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught.status).toBeNull();
  });

  it('default platform path (non-win32) still works via execFileSync', () => {
    // On any platform this exercises the direct-exec branch (mac/Linux contract).
    const out = execCli(process.execPath, ['-e', 'console.log("ok")'], { encoding: 'utf8' });
    expect(out.trim()).toBe('ok');
  });
});

// The win32 branch exists because npm/npx/claude are installed as .cmd shims,
// which cross-spawn routes through cmd.exe. The tests above use node.exe
// (direct CreateProcess, no cmd.exe), so they never exercise the shim path the
// original bug lived in. This case drives a real .cmd shim and pins the full
// contract there: backslashes survive, spaces don't split, &/% aren't
// interpreted. Windows-only (a .cmd file is meaningless on POSIX).
describe.skipIf(process.platform !== 'win32')('execCli — .cmd shim forwarding', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sync-shim-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('preserves backslash paths, spaces and metacharacters through a real .cmd shim', () => {
    const echoJs = path.join(tmpDir, 'echo-argv.js');
    // slice(2): skip node + script path; echo only the args the shim forwarded
    fs.writeFileSync(echoJs, 'console.log(JSON.stringify(process.argv.slice(2)));');
    const shim = path.join(tmpDir, 'fwd.cmd');
    fs.writeFileSync(shim, `@echo off\r\nnode "${echoJs}" %*\r\n`);

    const dest = 'C:\\Users\\Some User\\.claude\\skills\\my-skill';
    const out = execCli(
      shim,
      ['a%PATH%b', 'x&echo INJ', dest],
      { encoding: 'utf8' },
      { platform: 'win32' }
    );
    expect(JSON.parse(out.trim())).toEqual(['a%PATH%b', 'x&echo INJ', dest]);
  });
});
