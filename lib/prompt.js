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
const CLEAR_BELOW = `${ESC}[J`;

// Terminal line-height math for pickFromList's in-place redraw.
//
// Redraw moves the cursor back to the top of the list and erases below using
// CSI A (cursor up) + CSI J (erase below) — the oldest, most universally
// supported ANSI primitives (Windows Terminal, conhost, mintty, xterm all
// implement them). Earlier versions used cursor save/restore (ESC[s/ESC[u),
// which some Windows terminals silently ignore — each redraw then *appended*
// a fresh copy of the list instead of overwriting, producing duplicated
// renders (the "What would you like to do? … What would you like to do?"
// symptom). Height is computed from the rendered lines (ANSI-stripped visible
// width, wrapped to the terminal width), so the math holds even when a long
// item wraps to a second terminal line.

/**
 * Display width of one code point: wide/fullwidth characters (CJK, Hangul,
 * fullwidth forms, emoji) occupy two terminal columns, everything else one.
 * Based on the Unicode East Asian Wide/Fullwidth ranges.
 */
function charDisplayWidth(code) {
  // Zero-width: the Latin/Greek-style combining marks, variation selectors,
  // ZWSP/ZWNJ/ZWJ (emoji sequences), LRM/RLM direction marks, BOM and emoji
  // skin-tone modifiers occupy no terminal columns. Combining-mark coverage is
  // representative, not exhaustive (Arabic/Hebrew/Indic combining marks are
  // omitted — irrelevant for the CJK/ASCII UI this guards). Width stays
  // approximate for multi-codepoint emoji graphemes (a ZWJ family emoji renders
  // as one glyph but is measured per codepoint) — the common CJK/fullwidth
  // cases this guards are all single-codepoint and exact.
  if (
    (code >= 0x0300 && code <= 0x036f) ||   // Combining Diacritical Marks
    (code >= 0x1ab0 && code <= 0x1aff) ||   // Combining Marks Extended
    (code >= 0x1dc0 && code <= 0x1dff) ||   // Combining Marks Supplement
    (code >= 0x20d0 && code <= 0x20ff) ||   // Combining Marks for Symbols
    (code >= 0xfe20 && code <= 0xfe2f) ||   // Combining Half Marks
    (code >= 0x200b && code <= 0x200d) ||   // ZWSP / ZWNJ / ZWJ (emoji sequences)
    (code === 0x200e || code === 0x200f) || // LRM / RLM direction marks
    (code === 0x2060) ||                    // Word joiner
    (code === 0xfeff) ||                    // BOM / zero-width no-break space
    (code >= 0xfe00 && code <= 0xfe0f) ||   // Variation Selectors (VS15/VS16)
    (code >= 0x1f3fb && code <= 0x1f3ff)    // Emoji skin tone modifiers
  ) return 0;
  return (
    (code >= 0x1100 && code <= 0x115f) ||   // Hangul Jamo
    (code >= 0x2e80 && code <= 0x303e) ||   // CJK Radicals / Kangxi / CJK punct
    (code >= 0x3041 && code <= 0x33ff) ||   // Hiragana / Katakana / CJK symbols
    (code >= 0x3400 && code <= 0x4dbf) ||   // CJK Ext A
    (code >= 0x4dc0 && code <= 0x4dff) ||   // Yijing Hexagram Symbols
    (code >= 0x4e00 && code <= 0x9fff) ||   // CJK Unified Ideographs
    (code >= 0xa000 && code <= 0xa4cf) ||   // Yi
    (code >= 0xa960 && code <= 0xa97f) ||   // Hangul Jamo Extended-A
    (code >= 0xac00 && code <= 0xd7a3) ||   // Hangul Syllables
    (code >= 0xd7b0 && code <= 0xd7ff) ||   // Hangul Jamo Extended-B
    (code >= 0xf900 && code <= 0xfaff) ||   // CJK Compatibility Ideographs
    (code >= 0xfe10 && code <= 0xfe19) ||   // Vertical forms
    (code >= 0xfe30 && code <= 0xfe6f) ||   // CJK Compatibility Forms
    (code >= 0xff00 && code <= 0xff60) ||   // Fullwidth Forms
    (code >= 0xffe0 && code <= 0xffe6) ||   // Fullwidth signs
    (code >= 0x1f000 && code <= 0x1f1e5) || // Mahjong/Dominoes/Playing cards/Encl. alnum
    (code >= 0x1f200 && code <= 0x1f2ff) || // Enclosed ideographic supplement
    (code >= 0x1f300 && code <= 0x1faff) || // Emoji & pictographs (supplementary)
    (code >= 0x20000 && code <= 0x3fffd)    // CJK Ext B and beyond
  ) ? 2 : 1;
}

/** Visible (ANSI-stripped) display width of a rendered line. */
export function visibleLen(s) {
  const plain = s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
  let w = 0;
  for (const ch of plain) w += charDisplayWidth(ch.codePointAt(0));
  return w;
}

/** Pad a rendered line to a target DISPLAY width (wide chars occupy 2 columns). */
function padToDisplay(s, width) {
  const diff = width - visibleLen(s);
  return diff > 0 ? s + ' '.repeat(diff) : s;
}

/** Number of terminal lines a block of rendered lines occupies. */
export function blockHeight(lines, width = process.stdout.columns || 80) {
  let h = 0;
  for (const l of lines) {
    const L = visibleLen(l);
    h += L === 0 ? 1 : Math.ceil(L / width);
  }
  return h;
}

let lastBlockHeight = 0;

function writeBlock(lines) {
  lastBlockHeight = blockHeight(lines);
  process.stdout.write(lines.join('\n') + '\n');
}

/**
 * Dimmed text for hints.
 */
function dim(text) {
  return `${ESC}[2m${text}${RESET}`;
}

/**
 * Interactive list selector with arrow key navigation.
 *
 * Redraws in place using CSI cursor-up + erase-below (see blockHeight above),
 * so it works on any ANSI terminal without relying on cursor save/restore.
 *
 * @param {string} question - prompt shown above the list
 * @param {string[]} items - list of items to choose from
 * @param {string} [defaultItem] - pre-selected item (highlighted initially)
 * @param {string[]} [header] - optional static lines rendered above question
 * @param {string[]} [footer] - optional lines rendered below items (error/status messages)
 * @param {boolean} [clearOnDone] - when true, erase this render (cursor-up to its
 *   top + erase-below) before resolving, so a retry loop that calls pickFromList
 *   again starts clean instead of stacking a new copy on top of the old one.
 *   Leave off for one-shot prompts where the picked list should stay on screen.
 * @returns {Promise<string>} the chosen item
 */
export async function pickFromList(question, items, defaultItem, header, footer, clearOnDone = false) {
  if (!isInteractive() || items.length === 0) {
    return defaultItem || items[0] || '';
  }

  const count = items.length;
  const def = defaultItem || items[0];
  let selectedIdx = Math.max(0, items.indexOf(def));

  // Column layout: ≤5 items → 1 col, ≤20 → 2 cols, >20 → 3 cols
  let cols = 1;
  if (count > 20) cols = 3;
  else if (count > 5) cols = 2;
  const colWidth = Math.ceil(count / cols);

  function renderList() {
    const lines = [];

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
          const padded = padToDisplay(entry, 32);
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
      lines.push(`  ${dim('↑↓ navigate  ⏎ confirm')}`);
    }

    // Footer: status/error messages at the bottom
    if (footer && footer.length > 0) {
      lines.push('');
      for (const f of footer) lines.push(f);
    }

    lines.push('');
    return lines;
  }

  return new Promise(resolve => {
    const stdin = process.stdin;
    const stdout = process.stdout;

    if (typeof stdin.setRawMode === 'function') {
      stdin.setRawMode(true);
    }
    stdout.write(HIDE_CURSOR);
    writeBlock(renderList());

    function cleanup() {
      stdout.write(SHOW_CURSOR);
      if (typeof stdin.setRawMode === 'function') {
        stdin.setRawMode(false);
      }
      stdin.removeListener('data', onData);
      stdin.pause();
    }

    function redraw() {
      // Cursor sits on the line below the block; move up by the block's height
      // to its first line, erase everything below it, then re-render in place.
      stdout.write(`\r\x1b[${lastBlockHeight}A${CLEAR_BELOW}`);
      writeBlock(renderList());
    }

    function finish(result) {
      if (clearOnDone) {
        // Erase this instance's render and park the cursor at its top, so a
        // following pickFromList (e.g. a Retry in a loop) draws fresh instead of
        // stacking on top of the previous render. Same CSI cursor-up + erase-below
        // math as redraw — no reliance on ESC[s/ESC[u, which some Windows
        // terminals silently ignore.
        stdout.write(`\r\x1b[${lastBlockHeight}A${CLEAR_BELOW}`);
      } else {
        stdout.write('\n');
      }
      cleanup();
      resolve(result);
    }

    function onData(buf) {
      const key = buf.toString();

      if (key === `${ESC}[A` || key === 'k') {
        if (selectedIdx > 0) { selectedIdx--; redraw(); }
      } else if (key === `${ESC}[B` || key === 'j') {
        if (selectedIdx < count - 1) { selectedIdx++; redraw(); }
      } else if (key === '\r' || key === '\n' || key === ' ') {
        finish(items[selectedIdx]);
      } else if (key === 'q' || key === `${ESC}`) {
        finish(def);
      } else if (key === '\x03') {
        cleanup();
        stdout.write('\n');
        process.exit(0);
      }
    }

    stdin.resume();
    stdin.on('data', onData);
  });
}
