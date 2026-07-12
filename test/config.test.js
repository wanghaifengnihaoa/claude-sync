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
});
