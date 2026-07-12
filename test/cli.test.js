import { describe, it, expect } from 'vitest';
import { parseArgs } from '../claude-sync.js';

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
});
