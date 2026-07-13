/**
 * Interactive prompt utilities for claude-sync.
 * Single implementation used by cli and workflow modules.
 */

import * as readline from 'node:readline';

function isInteractive() {
  return process.stdin.isTTY && process.stdout.isTTY;
}

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

// ANSI escape codes
const ESC = '\x1b';
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const REVERSE = `${ESC}[7m`;
const RESET = `${ESC}[0m`;

/**
 * Dimmed text for hints.
 */
function borderText(text) {
  return `${ESC}[2m${text}${RESET}`;
}

/**
 * Move cursor up by n lines.
 */
function cursorUp(n) {
  if (n > 0) process.stdout.write(`${ESC}[${n}A`);
}

/**
 * Interactive list selector with arrow key navigation.
 * User presses ↑/↓ to highlight, Enter to confirm.
 *
 * For large lists (>20 items): displays in multiple columns.
 * For tiny lists (≤5 items): shows all in a single column.
 *
 * @param {string} question - prompt shown above the list
 * @param {string[]} items - list of items to choose from
 * @param {string} [defaultItem] - pre-selected item (highlighted initially)
 * @param {string[]} [header] - optional static lines rendered above the list (not redrawn on arrow press)
 * @returns {Promise<string>} the chosen item
 */
export async function pickFromList(question, items, defaultItem, header) {
  if (!isInteractive() || items.length === 0) {
    return defaultItem || items[0] || '';
  }

  const count = items.length;
  const def = defaultItem || items[0];
  let selectedIdx = Math.max(0, items.indexOf(def));

  // Determine column layout: ≤5 items → 1 col, ≤20 → 2 cols, >20 → 3 cols
  let cols = 1;
  if (count > 20) cols = 3;
  else if (count > 5) cols = 2;
  const colWidth = Math.ceil(count / cols);

  const headerLines = header ? header.length + 1 : 0; // +1 for blank line after header

  // Render the list with the current selection highlighted
  function renderList() {
    const lines = [];

    // Static header (rendered once, included in line count for cursorUp)
    if (header) {
      for (const h of header) lines.push(h);
      lines.push('');
    }

    lines.push(question);
    lines.push('');

    for (let row = 0; row < colWidth; row++) {
      const parts = [];
      for (let c = 0; c < cols; c++) {
        const idx = row + c * colWidth;
        if (idx < count) {
          const num = String(idx + 1).padStart(3, ' ');
          const entry = `${num}) ${items[idx]}`;
          const padded = entry.padEnd(32);
          if (idx === selectedIdx) {
            parts.push(`${REVERSE}${padded}${RESET}`);
          } else {
            parts.push(padded);
          }
        }
      }
      lines.push(`  ${parts.join('')}`);
    }

    if (count > 20) {
      lines.push('');
      lines.push(`  ${borderText('↑↓ navigate  ⏎ confirm')}`);
    }

    lines.push('');
    return lines.join('\n');
  }

  return new Promise(resolve => {
    const stdin = process.stdin;
    const stdout = process.stdout;

    if (typeof stdin.setRawMode === 'function') {
      stdin.setRawMode(true);
    }
    stdout.write(HIDE_CURSOR);

    // Draw initial list
    const initialLines = renderList().split('\n').length;
    stdout.write(renderList());

    function cleanup() {
      stdout.write(SHOW_CURSOR);
      if (typeof stdin.setRawMode === 'function') {
        stdin.setRawMode(false);
      }
      stdin.removeListener('data', onData);
      stdin.pause();
    }

    function onData(buf) {
      const key = buf.toString();

      // Up arrow: \x1b[A  or  k (vim-style)
      if (key === `${ESC}[A` || key === 'k') {
        if (selectedIdx > 0) {
          selectedIdx--;
          const newLines = renderList().split('\n').length;
          cursorUp(initialLines);
          stdout.write(renderList());
          // If the list shrank/grew, adjust
        }
      }
      // Down arrow: \x1b[B  or  j (vim-style)
      else if (key === `${ESC}[B` || key === 'j') {
        if (selectedIdx < count - 1) {
          selectedIdx++;
          cursorUp(initialLines);
          stdout.write(renderList());
        }
      }
      // Enter / Space
      else if (key === '\r' || key === '\n' || key === ' ') {
        cleanup();
        stdout.write('\n');
        resolve(items[selectedIdx]);
      }
      // q / Escape — use default
      else if (key === 'q' || key === `${ESC}`) {
        cleanup();
        stdout.write('\n');
        resolve(def);
      }
      // Ctrl+C
      else if (key === '\x03') {
        cleanup();
        stdout.write('\n');
        process.exit(0);
      }
    }

    stdin.resume();
    stdin.on('data', onData);
  });
}
