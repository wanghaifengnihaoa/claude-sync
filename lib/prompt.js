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

/**
 * Let user pick from a list — by number or by typing a name.
 * For large lists, displays in multiple columns so they fit on screen.
 *
 * @param {string} question - prompt text above the list
 * @param {string[]} items - list of items to choose from
 * @param {string} [defaultItem] - item used when user presses Enter without input
 * @returns {Promise<string>} the chosen item
 */
export async function pickFromList(question, items, defaultItem) {
  if (!process.stdin.isTTY) return Promise.resolve(defaultItem || items[0] || '');

  const def = defaultItem || items[0];
  const count = items.length;

  // Determine column layout: up to 5 items → 1 col, up to 20 → 2 cols, more → 3 cols
  let cols = 1;
  if (count > 20) cols = 3;
  else if (count > 5) cols = 2;

  const colWidth = Math.ceil(count / cols);
  console.log(question);

  for (let row = 0; row < colWidth; row++) {
    const lineParts = [];
    for (let c = 0; c < cols; c++) {
      const idx = row + c * colWidth;
      if (idx < count) {
        const num = String(idx + 1).padStart(String(count).length + 1, ' ');
        const entry = `${num}) ${items[idx]}`;
        // Pad each column to ~32 chars for alignment
        lineParts.push(entry.padEnd(32));
      }
    }
    console.log(`  ${lineParts.join('')}`);
  }

  // If list is long (> 20), also show a separator with the first few items as hints
  if (count > 20) {
    console.log(`  ${'─'.repeat(64)}`);
    console.log(`  Quick pick: type a number (1-${count}) or the remote name directly`);
  }

  const answer = await prompt(`\nPick one (number or name) [${def}]: `);

  if (!answer) return def;

  // Try numeric index first
  const num = parseInt(answer, 10);
  if (!isNaN(num) && num >= 1 && num <= count) return items[num - 1];

  // Try exact match (case-insensitive)
  const lower = answer.toLowerCase();
  const exact = items.find(i => i.toLowerCase() === lower);
  if (exact) return exact;

  // Try contains match
  const matches = items.filter(i => i.toLowerCase().includes(lower));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    console.log(`  Ambiguous — matched: ${matches.join(', ')}`);
    return await pickFromList('Which one?', matches, matches[0]);
  }

  // No match found — treat as literal input (user might be entering a new remote name)
  console.log(`  '${answer}' not found in list. Using as literal remote name.`);
  return answer;
}
