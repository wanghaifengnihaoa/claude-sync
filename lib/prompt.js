/**
 * Interactive prompt utilities for claude-sync.
 * Single implementation used by cli and workflow modules.
 */

import * as readline from 'node:readline';

export function prompt(question) {
  if (!process.stdin.isTTY) return Promise.resolve('');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer.trim()); }));
}

export async function promptYesNo(question, defaultYes = true) {
  const suffix = defaultYes ? ' [Y/n] ' : ' [y/N] ';
  const answer = await prompt(question + suffix);
  const lower = answer.toLowerCase();
  if (lower === 'y' || lower === 'yes') return true;
  if (lower === 'n' || lower === 'no') return false;
  return defaultYes;
}
