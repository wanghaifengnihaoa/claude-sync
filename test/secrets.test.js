import { describe, it, expect } from 'vitest';
import { stripSecrets, isStripped, findSecretFields } from '../lib/secrets.js';

describe('stripSecrets', () => {
  it('replaces env values with *** in settings.json while keeping keys', () => {
    const settings = {
      env: {
        ANTHROPIC_AUTH_TOKEN: 'sk-ant-real-token-123',
        ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
        OPENAI_API_KEY: 'sk-openai-real-key-456'
      },
      model: 'claude-sonnet-4-6',
      statusLine: { type: 'bun', path: '/opt/homebrew/bin/bun' }
    };

    const result = stripSecrets(settings, 'settings');

    expect(result.env.ANTHROPIC_AUTH_TOKEN).toBe('***');
    expect(result.env.OPENAI_API_KEY).toBe('***');
    expect(result.env.ANTHROPIC_BASE_URL).toBe('https://api.anthropic.com');
    expect(result.model).toBe('claude-sonnet-4-6');
    expect(result.statusLine).toEqual({ type: 'bun', path: '/opt/homebrew/bin/bun' });
  });

  it('replaces mcpServers config values with *** in claude.json fragment', () => {
    const mcpServers = {
      figma: {
        type: 'http',
        url: 'http://localhost:3333',
        config: {
          FIGMA_API_KEY: 'figd-real-key-789',
          FIGMA_FILE_KEY: 'abc123'
        }
      },
      github: {
        type: 'stdio',
        command: 'gh',
        args: ['copilot']
      }
    };

    const result = stripSecrets(mcpServers, 'mcpServers');

    expect(result.figma.config.FIGMA_API_KEY).toBe('***');
    expect(result.figma.config.FIGMA_FILE_KEY).toBe('***');
    expect(result.figma.type).toBe('http');
    expect(result.github.command).toBe('gh');
  });

  it('returns unchanged object when no secrets found', () => {
    const settings = {
      model: 'claude-sonnet-4-6',
      theme: 'dark'
    };

    const result = stripSecrets(settings, 'settings');

    expect(result).toEqual(settings);
  });

  it('returns unchanged for non-sensitive object types', () => {
    const data = { someKey: 'someValue' };
    const result = stripSecrets(data, 'unknown');
    expect(result).toEqual(data);
  });
});

describe('isStripped', () => {
  it('returns true for *** placeholder values', () => {
    expect(isStripped('***')).toBe(true);
  });

  it('returns false for real values', () => {
    expect(isStripped('sk-ant-real-key')).toBe(false);
    expect(isStripped('')).toBe(false);
    expect(isStripped('****')).toBe(false);
  });
});

describe('findSecretFields', () => {
  it('finds all stripped fields with their paths', () => {
    const settings = {
      env: {
        ANTHROPIC_AUTH_TOKEN: '***',
        ANTHROPIC_BASE_URL: 'https://api.anthropic.com'
      }
    };

    const fields = findSecretFields(settings, 'settings');

    expect(fields).toHaveLength(1);
    expect(fields[0]).toEqual({
      path: 'env.ANTHROPIC_AUTH_TOKEN',
      value: '***'
    });
  });

  it('finds stripped mcpServer config keys', () => {
    const mcpServers = {
      figma: {
        type: 'http',
        config: {
          FIGMA_API_KEY: '***'
        }
      }
    };

    const fields = findSecretFields(mcpServers, 'mcpServers');

    expect(fields).toHaveLength(1);
    expect(fields[0]).toEqual({
      path: 'figma.config.FIGMA_API_KEY',
      value: '***'
    });
  });

  it('returns empty array when no stripped values found', () => {
    const settings = {
      env: {
        ANTHROPIC_BASE_URL: 'https://api.anthropic.com'
      }
    };

    const fields = findSecretFields(settings, 'settings');
    expect(fields).toHaveLength(0);
  });
});
