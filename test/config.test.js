import { describe, it, expect } from 'vitest';
import { readConfig, getDefaultConfig } from '../lib/config.js';

describe('getDefaultConfig', () => {
  it('returns sensible defaults', () => {
    const config = getDefaultConfig();
    expect(config.BACKEND).toBe('rclone');
    expect(config.SECRETS).toBe('keep');
    expect(config.BUNDLE_DIR).toContain('.claude-sync-bundle');
    expect(config.CLAUDE_DIR).toContain('.claude');
  });
});

describe('readConfig', () => {
  it('merges user config with defaults', () => {
    const userConfig = {
      REMOTE: 'myremote:claude-sync/',
      BACKEND: 'rclone'
    };
    const config = readConfig(userConfig);
    expect(config.REMOTE).toBe('myremote:claude-sync/');
    expect(config.BACKEND).toBe('rclone');
    expect(config.SECRETS).toBe('keep');
    expect(config.BUNDLE_DIR).toContain('.claude-sync-bundle');
  });

  it('returns defaults when no user config provided', () => {
    const config = readConfig({});
    expect(config.BACKEND).toBe('rclone');
    expect(config.SECRETS).toBe('keep');
    expect(config.REMOTE).toBeUndefined();
  });

  it('expands ~ in BUNDLE_DIR and CLAUDE_DIR to absolute paths', () => {
    const userConfig = {
      BUNDLE_DIR: '~/my-bundle',
      CLAUDE_DIR: '~/.claude'
    };
    const config = readConfig(userConfig);
    expect(config.BUNDLE_DIR).not.toContain('~');
    expect(config.BUNDLE_DIR).toContain('my-bundle');
    expect(config.CLAUDE_DIR).not.toContain('~');
    expect(config.CLAUDE_DIR).toContain('.claude');
  });

  it('does not modify absolute paths', () => {
    const userConfig = {
      BUNDLE_DIR: '/tmp/my-bundle',
      CLAUDE_DIR: '/home/user/.claude'
    };
    const config = readConfig(userConfig);
    expect(config.BUNDLE_DIR).toBe('/tmp/my-bundle');
    expect(config.CLAUDE_DIR).toBe('/home/user/.claude');
  });

  it('parses EXCLUDE string into array', () => {
    const config = readConfig({ EXCLUDE: 'commands, agents' });
    expect(Array.isArray(config.EXCLUDE)).toBe(true);
    expect(config.EXCLUDE).toEqual(['commands', 'agents']);
  });

  it('handles EXCLUDE as space-separated string', () => {
    const config = readConfig({ EXCLUDE: 'commands agents hooks' });
    expect(Array.isArray(config.EXCLUDE)).toBe(true);
    expect(config.EXCLUDE).toEqual(['commands', 'agents', 'hooks']);
  });

  it('keeps EXCLUDE as array when already an array', () => {
    const config = readConfig({ EXCLUDE: ['custom-dir'] });
    expect(Array.isArray(config.EXCLUDE)).toBe(true);
    expect(config.EXCLUDE).toEqual(['custom-dir']);
  });

  it('defaults EXCLUDE to empty array', () => {
    const config = readConfig({});
    expect(Array.isArray(config.EXCLUDE)).toBe(true);
    expect(config.EXCLUDE).toEqual([]);
  });
});
