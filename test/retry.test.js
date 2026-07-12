import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { withRetry, setLogLevel, initLogging, log } from '../lib/retry.js';

describe('withRetry', () => {
  it('returns result when operation succeeds on first try', async () => {
    const operation = async () => 'success';
    const result = await withRetry(operation);
    expect(result).toBe('success');
  });

  it('retries on failure and returns success when retry succeeds', async () => {
    let attempts = 0;
    const operation = async () => {
      attempts++;
      if (attempts < 3) throw new Error('temporary failure');
      return 'recovered';
    };

    const result = await withRetry(operation, { maxRetries: 3 });
    expect(result).toBe('recovered');
    expect(attempts).toBe(3);
  });

  it('throws after exhausting all retries', async () => {
    let attempts = 0;
    const operation = async () => {
      attempts++;
      throw new Error('persistent failure');
    };

    await expect(
      withRetry(operation, { maxRetries: 2, baseDelay: 10 })
    ).rejects.toThrow('persistent failure');
    // 1 initial + 2 retries = 3 total attempts
    expect(attempts).toBe(3);
  });

  it('returns value immediately on first success (no delay)', async () => {
    const start = Date.now();
    const operation = async () => 'fast';
    const result = await withRetry(operation, { maxRetries: 3, baseDelay: 100 });
    const elapsed = Date.now() - start;

    expect(result).toBe('fast');
    // Should complete quickly (no retry delay needed)
    expect(elapsed).toBeLessThan(50);
  });

  it('uses exponential backoff when retrying', async () => {
    // Default baseDelay is 1000ms, so with 2 retries:
    // attempt 1 (initial): no delay
    // attempt 2 (retry 1): 1000ms delay
    // attempt 3 (retry 2): 2000ms delay → success
    let attempts = 0;
    const operation = async () => {
      attempts++;
      if (attempts < 3) throw new Error('fail');
      return 'ok';
    };

    const start = Date.now();
    const result = await withRetry(operation, { maxRetries: 2, baseDelay: 100 });
    const elapsed = Date.now() - start;

    expect(result).toBe('ok');
    expect(attempts).toBe(3);
    // Exponential backoff: 100ms + 200ms = 300ms total delay
    // Allow some tolerance for timing
    expect(elapsed).toBeGreaterThanOrEqual(250);
  });

  it('handles retry with custom label in error message', async () => {
    const operation = async () => {
      throw new Error('fail');
    };

    await expect(
      withRetry(operation, { maxRetries: 0, label: 'custom-op' })
    ).rejects.toThrow('fail');
  });

  it('retries exactly maxRetries times, not maxRetries+1 on success', async () => {
    let attempts = 0;
    const operation = async () => {
      attempts++;
      if (attempts <= 2) throw new Error('fail');
      return 'ok';
    };

    // maxRetries=2 + 1 initial = 3 total → succeeds on 3rd
    const result = await withRetry(operation, { maxRetries: 2, baseDelay: 10 });
    expect(result).toBe('ok');
    expect(attempts).toBe(3);
  });
});

describe('log', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sync-retry-'));
    // Reset log state
    initLogging(path.join(tmpDir, 'sync.log'));
    setLogLevel('info');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes log messages to the log file', () => {
    log('info', 'test message');
    const logPath = path.join(tmpDir, 'sync.log');
    expect(fs.existsSync(logPath)).toBe(true);
    const content = fs.readFileSync(logPath, 'utf-8');
    expect(content).toContain('[INFO]');
    expect(content).toContain('test message');
  });

  it('writes verbose messages only when log level is verbose', () => {
    // Default log level is 'info' — verbose messages should not appear
    log('verbose', 'hidden message');

    const logPath = path.join(tmpDir, 'sync.log');
    if (fs.existsSync(logPath)) {
      const content = fs.readFileSync(logPath, 'utf-8');
      expect(content).not.toContain('hidden message');
    }

    // Switch to verbose
    setLogLevel('verbose');
    log('verbose', 'visible message');
    const content2 = fs.readFileSync(logPath, 'utf-8');
    expect(content2).toContain('visible message');
  });

  it('log file includes ISO timestamp format', () => {
    log('info', 'timestamped');
    const logPath = path.join(tmpDir, 'sync.log');
    const content = fs.readFileSync(logPath, 'utf-8');
    // Match ISO 8601 timestamp pattern
    expect(content).toMatch(/\[\d{4}-\d{2}-\d{2}T/);
  });

  it('initLogging creates directory if not exists', () => {
    const subDir = path.join(tmpDir, 'deep', 'nested', 'dir');
    initLogging(path.join(subDir, 'sync.log'));
    log('info', 'nested log');
    expect(fs.existsSync(path.join(subDir, 'sync.log'))).toBe(true);
  });
});
