import { describe, it, expect } from 'vitest';
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
    const out = execCli(process.execPath, ['-e', ECHO_ARGV, 'hello world'], { encoding: 'utf8' }, 'win32');
    expect(JSON.parse(out.trim())).toEqual(['hello world']);
  });

  it('keeps a Windows path with spaces intact', () => {
    const dest = path.join(os.tmpdir(), 'claude-sync exec cli dest'); // real space on every platform
    const out = execCli(process.execPath, ['-e', ECHO_ARGV, dest], { encoding: 'utf8' }, 'win32');
    expect(JSON.parse(out.trim())).toEqual([dest]);
  });

  it('does not interpret shell metacharacters in an arg (& / | / >)', () => {
    const out = execCli(process.execPath, ['-e', 'console.log(process.argv[1])', 'x&echo INJECTED'], { encoding: 'utf8' }, 'win32');
    expect(out.trim()).toBe('x&echo INJECTED');
  });

  it('does not expand %VAR% in an arg', () => {
    const out = execCli(process.execPath, ['-e', 'console.log(process.argv[1])', 'a%PATH%b'], { encoding: 'utf8' }, 'win32');
    expect(out.trim()).toBe('a%PATH%b');
  });

  it('throws with the exit status on a non-zero exit', () => {
    let caught = null;
    try {
      execCli(process.execPath, ['-e', 'process.exit(3)'], { encoding: 'utf8' }, 'win32');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught.status).toBe(3);
  });

  it('default platform path (non-win32) still works via execFileSync', () => {
    // On any platform this exercises the direct-exec branch (mac/Linux contract).
    const out = execCli(process.execPath, ['-e', 'console.log("ok")'], { encoding: 'utf8' });
    expect(out.trim()).toBe('ok');
  });
});
