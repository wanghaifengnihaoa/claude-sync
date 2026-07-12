/**
 * Retry utility with exponential backoff and logging.
 * Plan requirement: network operations retry 3 times with exponential backoff.
 * Plan requirement: sync.log file + --verbose flag.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY = 1000;

// --- Retry ---

export async function withRetry(fn, { maxRetries = DEFAULT_MAX_RETRIES, baseDelay = DEFAULT_BASE_DELAY, label = 'operation' } = {}) {
  let lastError;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt <= maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt - 1);
        log('verbose', `Retry ${attempt}/${maxRetries} for ${label} in ${delay}ms: ${err.message}`);
        await sleep(delay);
      }
    }
  }

  throw lastError;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// --- Logging ---

let logLevel = 'info';
let logFilePath = null;

const LOG_DIR = path.join(os.homedir(), '.claude-sync-bundle');
const DEFAULT_LOG_FILE = path.join(LOG_DIR, 'sync.log');

export function setLogLevel(level) {
  logLevel = level;
}

export function initLogging(logPath) {
  logFilePath = logPath || DEFAULT_LOG_FILE;
  const dir = path.dirname(logFilePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function log(level, message) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${level.toUpperCase()}] ${message}`;

  if (level === 'verbose' && logLevel !== 'verbose') return;
  if (level === 'error') {
    console.error(line);
  } else {
    console.log(line);
  }

  if (logFilePath) {
    try {
      fs.appendFileSync(logFilePath, line + '\n');
    } catch { /* ignore log file errors */ }
  }
}
