import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseArgs, isMainCheck } from '../claude-sync.js';
import { pickFromList } from '../lib/prompt.js';

describe('pickFromList (non-interactive)', () => {
  it('returns default item in non-TTY mode', async () => {
    const result = await pickFromList('Choose:', ['a', 'b', 'c'], 'b');
    expect(result).toBe('b');
  });

  it('returns first item when no default and non-TTY', async () => {
    const result = await pickFromList('Choose:', ['x', 'y', 'z']);
    expect(result).toBe('x');
  });

  it('returns empty string for empty list', async () => {
    const result = await pickFromList('Choose:', [], 'fallback');
    expect(result).toBe('fallback');
  });

  it('works with header parameter (non-TTY)', async () => {
    const result = await pickFromList('Pick:', ['a', 'b'], 'a', ['Header line 1', 'Header line 2']);
    expect(result).toBe('a');
  });

  it('uses item matching for default selection', async () => {
    const result = await pickFromList('Pick:', ['apple', 'banana', 'cherry'], 'cherry');
    expect(result).toBe('cherry');
  });
});

describe('parseArgs', () => {
  it('parses push command', () => {
    const result = parseArgs(['node', 'claude-sync.js', 'push']);
    expect(result.command).toBe('push');
    expect(result.flags).toEqual({});
  });

  it('parses pull command with flags', () => {
    const result = parseArgs(['node', 'claude-sync.js', 'pull', '--cover']);
    expect(result.command).toBe('pull');
    expect(result.flags.cover).toBe(true);
  });

  it('parses pull with --keep flag', () => {
    const result = parseArgs(['node', 'claude-sync.js', 'pull', '--keep']);
    expect(result.command).toBe('pull');
    expect(result.flags.keep).toBe(true);
  });

  it('parses pull with --dry-run flag', () => {
    const result = parseArgs(['node', 'claude-sync.js', 'pull', '--dry-run']);
    expect(result.command).toBe('pull');
    expect(result.flags['dry-run']).toBe(true);
  });

  it('parses push with --force flag', () => {
    const result = parseArgs(['node', 'claude-sync.js', 'push', '--force']);
    expect(result.command).toBe('push');
    expect(result.flags.force).toBe(true);
  });

  it('parses init command', () => {
    const result = parseArgs(['node', 'claude-sync.js', 'init']);
    expect(result.command).toBe('init');
  });

  it('parses status command', () => {
    const result = parseArgs(['node', 'claude-sync.js', 'status']);
    expect(result.command).toBe('status');
  });

  it('parses diff command', () => {
    const result = parseArgs(['node', 'claude-sync.js', 'diff']);
    expect(result.command).toBe('diff');
  });

  it('parses restore command with --backup flag', () => {
    const result = parseArgs(['node', 'claude-sync.js', 'restore', '--backup', '20260712-120000']);
    expect(result.command).toBe('restore');
    expect(result.flags.backup).toBe('20260712-120000');
  });

  it('parses restore --list', () => {
    const result = parseArgs(['node', 'claude-sync.js', 'restore', '--list']);
    expect(result.command).toBe('restore');
    expect(result.flags.list).toBe(true);
  });

  it('defaults to help when no command given', () => {
    const result = parseArgs(['node', 'claude-sync.js']);
    expect(result.command).toBe('help');
  });

  it('handles unknown commands gracefully', () => {
    const result = parseArgs(['node', 'claude-sync.js', 'unknown-cmd']);
    expect(result.command).toBe('unknown-cmd');
  });

  it('parses -v as version flag', () => {
    const result = parseArgs(['node', 'claude-sync.js', '-v']);
    expect(result.flags.version).toBe(true);
  });

  it('parses --version as version flag', () => {
    const result = parseArgs(['node', 'claude-sync.js', '--version']);
    expect(result.flags.version).toBe(true);
  });

  it('parses -h as help flag', () => {
    const result = parseArgs(['node', 'claude-sync.js', '-h']);
    expect(result.flags.help).toBe(true);
  });

  it('parses --help as help flag', () => {
    const result = parseArgs(['node', 'claude-sync.js', '--help']);
    expect(result.flags.help).toBe(true);
  });
});

describe('isMainCheck', () => {
  it('returns false when argv1 is undefined', () => {
    expect(isMainCheck(undefined, import.meta.url)).toBe(false);
  });

  it('returns true when argv1 basename is claude-sync', () => {
    expect(isMainCheck('/usr/local/bin/claude-sync', import.meta.url)).toBe(true);
  });

  it('returns true when argv1 resolves to the same file as metaUrl', () => {
    // For the currently running file, this should be true
    const realPath = fs.realpathSync(process.argv[1]);
    // Use a metaUrl that resolves to the same file
    expect(isMainCheck(realPath, `file://${realPath}`)).toBe(true);
  });

  it('returns false for a different file', () => {
    expect(isMainCheck('/usr/local/bin/some-other-tool', import.meta.url)).toBe(false);
  });
});
